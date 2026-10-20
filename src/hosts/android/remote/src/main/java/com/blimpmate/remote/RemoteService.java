package com.blimpmate.remote;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * The agent: stays connected to the stream server (started at boot), and when
 * a viewer asks for the screen gets screen capture and runs a ScreenSession,
 * whose video packets and the viewer's input share this connection.
 * Everything runs on one session thread.
 */
public final class RemoteService extends Service {
    private static final String TAG = "RemoteService";
    private static final String CHANNEL = "remote";
    private static final int NOTIFICATION = 1;
    private static final String ACTION_RECONNECT = "com.blimpmate.remote.RECONNECT";
    private static final String ACTION_INFO = "com.blimpmate.remote.INFO";
    private static final String BLIMP_APP = "com.l2dfacecontrol.host";
    private static final long PROJECTION_TIMEOUT_MS = 10_000;
    private static final long MAX_BACKOFF_MS = 30_000;

    /** What the setup screen shows. */
    public static volatile String status = "Not running";

    private HandlerThread thread;
    private Handler handler;
    private OkHttpClient http;
    private WebSocket ws;
    private boolean connected;
    private long backoffMs = 1000;
    private Runnable reconnect;
    // STUN/TURN servers for the direct path, from the server's welcome
    private JSONArray iceServers = new JSONArray();

    private MediaProjection projection;
    private ScreenSession session;
    private Runnable projectionTimeout;
    private int sessionSeq;
    private PowerManager.WakeLock wakeLock;
    private DisplayManager.DisplayListener displayListener;
    private ConnectivityManager.NetworkCallback networkCallback;

    public static void start(Context context) {
        context.startForegroundService(new Intent(context, RemoteService.class));
    }

    /** Reconnects with the saved settings (after the setup screen changes them). */
    public static void reconnect(Context context) {
        context.startForegroundService(new Intent(context, RemoteService.class).setAction(ACTION_RECONNECT));
    }

    /** Resends the device info (input control was turned on or off). */
    public static void refreshInfo(Context context) {
        context.startForegroundService(new Intent(context, RemoteService.class).setAction(ACTION_INFO));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Remote control", NotificationManager.IMPORTANCE_LOW));
        Notification n = notification("Starting");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION, n);
        }

        thread = new HandlerThread("remote");
        thread.start();
        handler = new Handler(thread.getLooper());
        http = new OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build();

        // A new network: reconnect now instead of waiting out the backoff
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    if (!connected && ws == null) {
                        backoffMs = 1000;
                        connectNow();
                    }
                });
            }
        };
        cm.registerDefaultNetworkCallback(networkCallback, handler);

        displayListener = new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int id) {}
            @Override public void onDisplayRemoved(int id) {}
            @Override
            public void onDisplayChanged(int id) {
                if (id == android.view.Display.DEFAULT_DISPLAY && session != null) session.onScreenSizeChanged();
            }
        };
        getSystemService(DisplayManager.class).registerDisplayListener(displayListener, handler);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        boolean force = ACTION_RECONNECT.equals(action);
        handler.post(() -> {
            if (ACTION_INFO.equals(action) && connected) sendInfo();
            if (force) {
                disconnect("settings changed");
                backoffMs = 1000;
            }
            if (ws == null) connectNow();
        });
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.post(() -> disconnect("service stopped"));
        getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        getSystemService(DisplayManager.class).unregisterDisplayListener(displayListener);
        thread.quitSafely();
        status = "Not running";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---- connection to the stream server (session thread) ----

    private void connectNow() {
        if (reconnect != null) {
            handler.removeCallbacks(reconnect);
            reconnect = null;
        }
        Config config = Config.load(this);
        if (!config.isComplete()) {
            setStatus("Not set up: open BlimpMate Remote and enter the server");
            return;
        }
        setStatus("Connecting to " + config.url);
        Request request;
        try {
            request = new Request.Builder().url(config.socketUrl()).build();
        } catch (IllegalArgumentException e) {
            setStatus("Bad server address: " + config.url);
            return;
        }
        ws = http.newWebSocket(request, new Listener());
    }

    private void scheduleReconnect(long delayMs) {
        if (reconnect != null) handler.removeCallbacks(reconnect);
        reconnect = this::connectNow;
        handler.postDelayed(reconnect, delayMs);
    }

    private void disconnect(String reason) {
        stopSession(null);
        if (ws != null) {
            ws.close(1000, reason);
            ws = null;
        }
        connected = false;
    }

    private void onClosed(WebSocket socket, int code, String reason) {
        if (socket != ws) return;
        ws = null;
        connected = false;
        stopSession(null);
        if (code == 4009) {
            // The server takes one device. Keep trying: the connected one may be
            // this device's own dead connection, which the server drops within 30 s.
            setStatus("Another device is connected to the server; retrying in 10 s");
            scheduleReconnect(10_000);
        } else if (code == 4003) {
            setStatus("Screen control is off on the server (set SCREEN_PASSWORD)");
            scheduleReconnect(60_000);
        } else {
            setStatus("Offline (" + reason + "); retrying in " + backoffMs / 1000 + " s");
            scheduleReconnect(backoffMs);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
    }

    private void onServerMessage(JSONObject msg) {
        switch (msg.optString("type")) {
            case "welcome":
                connected = true;
                backoffMs = 1000;
                iceServers = msg.optJSONArray("iceServers") != null ? msg.optJSONArray("iceServers") : new JSONArray();
                setStatus("Online");
                sendInfo();
                break;
            case "screen_start":
                startSession(msg.optString("preset", "medium"));
                break;
            case "screen_stop":
                stopSession(null);
                break;
            case "input":
                if (session != null && msg.optJSONObject("data") != null) session.onInput(msg.optJSONObject("data"));
                break;
            case "keyframe":
                if (session != null) session.requestKeyFrame();
                break;
            case "signal":
                if (session != null && msg.optJSONObject("data") != null) session.onSignal(msg.optJSONObject("data"));
                break;
        }
    }

    private void send(JSONObject msg) {
        if (ws != null) ws.send(msg.toString());
    }

    private void sendInfo() {
        Point size = new Point();
        getSystemService(DisplayManager.class).getDisplay(android.view.Display.DEFAULT_DISPLAY).getRealSize(size);
        try {
            JSONObject device = new JSONObject()
                    .put("model", Build.MODEL)
                    .put("manufacturer", Build.MANUFACTURER)
                    .put("android", Build.VERSION.RELEASE)
                    .put("sdk", Build.VERSION.SDK_INT)
                    .put("width", size.x)
                    .put("height", size.y)
                    .put("input", InputService.get() != null);
            send(new JSONObject().put("type", "info").put("device", device));
        } catch (Exception ignored) {}
    }

    // ---- screen sessions (session thread) ----

    private void startSession(String preset) {
        stopSession(null);
        int seq = ++sessionSeq;
        setStatus("Viewer connecting");
        acquireWakeLock();
        projectionTimeout = () -> {
            if (seq == sessionSeq && session == null) {
                failSession("Screen capture wasn't allowed. Run the setup step: adb shell appops set "
                        + getPackageName() + " PROJECT_MEDIA allow");
            }
        };
        handler.postDelayed(projectionTimeout, PROJECTION_TIMEOUT_MS);
        try {
            ProjectionActivity.request(this, (code, data) -> handler.post(() -> onProjection(seq, preset, code, data)));
        } catch (Exception e) {
            failSession("Couldn't ask for screen capture: " + e.getMessage());
        }
    }

    private void onProjection(int seq, String preset, int code, Intent data) {
        if (seq != sessionSeq) return;
        handler.removeCallbacks(projectionTimeout);
        if (code != Activity.RESULT_OK || data == null) {
            failSession("Screen capture was refused on the device (grant PROJECT_MEDIA with adb; see the setup screen)");
            return;
        }
        try {
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(code, data);
        } catch (Exception e) {
            failSession("Screen capture failed: " + e.getMessage());
            return;
        }
        if (projection == null) {
            failSession("Screen capture failed");
            return;
        }
        MediaProjection mine = projection;
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                handler.post(() -> {
                    if (projection == mine && session != null) failSession("Screen capture was stopped on the device");
                });
            }
        }, handler);
        WebSocket socket = ws;
        session = new ScreenSession(this, handler, projection, preset, iceServers, new ScreenSession.Listener() {
            @Override
            public boolean sendVideo(byte[] packet) {
                return socket != null && socket.send(ByteString.of(packet));
            }

            @Override
            public long backlog() {
                return socket == null ? 0 : socket.queueSize();
            }

            @Override
            public void sendToViewer(JSONObject message) {
                try {
                    send(new JSONObject().put("type", "viewer").put("data", message));
                } catch (Exception ignored) {}
            }

            @Override
            public void sendSignal(JSONObject data) {
                try {
                    send(new JSONObject().put("type", "signal").put("data", data));
                } catch (Exception ignored) {}
            }

            @Override
            public void onFailed(String error) {
                failSession(error);
            }

            @Override
            public String openBlimpApp() {
                return RemoteService.this.openBlimpApp();
            }
        });
        session.start();
        setStatus("A viewer is watching");
    }

    private void failSession(String error) {
        Log.w(TAG, "session failed: " + error);
        try {
            send(new JSONObject().put("type", "screen_error").put("error", error));
        } catch (Exception ignored) {}
        stopSession(error);
    }

    private void stopSession(String error) {
        sessionSeq++;
        if (projectionTimeout != null) handler.removeCallbacks(projectionTimeout);
        if (session != null) {
            session.close();
            session = null;
        }
        if (projection != null) {
            MediaProjection p = projection;
            projection = null;
            p.stop();
        }
        releaseWakeLock();
        if (connected) setStatus(error == null ? "Online" : "Online (last session: " + error + ")");
    }

    private String openBlimpApp() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(BLIMP_APP);
        if (launch == null) return "The Blimp app isn't installed";
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try {
            startActivity(launch);
            return null;
        } catch (Exception e) {
            return "Couldn't open the Blimp app: " + e.getMessage();
        }
    }

    // While someone watches, the screen stays on (and turns on if it was off)
    @SuppressWarnings("deprecation")
    private void acquireWakeLock() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "blimpmate:remote");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(4 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    // ---- status ----

    private void setStatus(String s) {
        status = s;
        Log.i(TAG, s);
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(s));
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, SetupActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("BlimpMate Remote")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onMessage(WebSocket socket, String text) {
            handler.post(() -> {
                if (socket != ws) return;
                try {
                    onServerMessage(new JSONObject(text));
                } catch (Exception e) {
                    Log.w(TAG, "bad server message", e);
                }
            });
        }

        @Override
        public void onClosing(WebSocket socket, int code, String reason) {
            socket.close(1000, null);
            handler.post(() -> RemoteService.this.onClosed(socket, code, reason));
        }

        @Override
        public void onFailure(WebSocket socket, Throwable t, Response response) {
            String reason = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            handler.post(() -> RemoteService.this.onClosed(socket, 1006, reason));
        }
    }
}
