package com.blimpmate.speaker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Keeps a websocket to xz-server's /xiaozhi/speaker/ and plays what the Blimp
 * plays: the AI's voice (Opus frames) and portal clips / video soundtracks
 * (fetched from the server's media links). Reconnects until stopped.
 */
public final class SpeakerService extends Service {
    private static final String TAG = "BlimpSpeaker";
    private static final String CHANNEL = "speaker";
    private static final int NOTIFICATION = 1;
    static final String ACTION_STOP = "stop";
    static final String PREFS = "speaker";
    static final String KEY_SERVER = "server";
    private static final int WS_PORT = 8000;

    /** Shown by the setup screen. */
    static volatile String status = "Stopped";

    private final OkHttpClient http = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    private HandlerThread thread;
    private Handler handler;
    private WebSocket socket;
    private int generation; // ignores callbacks from sockets that were replaced
    private long backoffMs = 2000;
    private String host;
    private VoicePlayer voice;
    private MediaPlayer clip;
    private boolean loop;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static void start(Context context) {
        context.startForegroundService(new Intent(context, SpeakerService.class));
    }

    static void stop(Context context) {
        context.startService(new Intent(context, SpeakerService.class).setAction(ACTION_STOP));
    }

    static String savedServer(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "");
    }

    static void saveServer(Context context, String server) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, server.trim()).apply();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Speaker", NotificationManager.IMPORTANCE_LOW));
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION, notification());
        }
        // Keep the CPU and Wi-Fi awake with the screen off: this device only plays sound
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BlimpSpeaker:play");
        wakeLock.acquire();
        wifiLock = getSystemService(WifiManager.class).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "BlimpSpeaker");
        wifiLock.acquire();
        thread = new HandlerThread("speaker");
        thread.start();
        handler = new Handler(thread.getLooper());
        voice = new VoicePlayer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.post(this::connect); // (re)connect with the saved server
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        status = "Stopped";
        handler.post(() -> {
            generation++;
            if (socket != null) socket.close(1000, "stopped");
            stopClip();
        });
        thread.quitSafely();
        voice.release();
        wakeLock.release();
        wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- connection ----------

    private void connect() {
        generation++;
        if (socket != null) socket.close(1000, "reconnecting");
        socket = null;
        String server = savedServer(this);
        if (server.isEmpty()) {
            status = "Enter the server address";
            return;
        }
        // "1.2.3.4", "1.2.3.4:8000" or "ws://1.2.3.4:8000"
        String hostPort = server.replaceFirst("^[a-z]+://", "").replaceAll("/.*$", "");
        host = hostPort.contains(":") ? hostPort.substring(0, hostPort.indexOf(':')) : hostPort;
        String wsUrl = "ws://" + (hostPort.contains(":") ? hostPort : hostPort + ":" + WS_PORT)
                + "/xiaozhi/speaker/?device-id=speaker-"
                + Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        status = "Connecting to " + hostPort + "…";
        final int gen = generation;
        Request request;
        try {
            request = new Request.Builder().url(wsUrl).build();
        } catch (IllegalArgumentException e) {
            status = "Invalid server address";
            return;
        }
        socket = http.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                handler.post(() -> {
                    if (gen != generation) return;
                    backoffMs = 2000;
                    status = "Connected to " + hostPort;
                    ping(gen);
                });
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handler.post(() -> {
                    if (gen == generation) onJson(text);
                });
            }

            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                if (gen == generation) voice.feed(bytes.toByteArray());
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                handler.post(() -> retry(gen, "Disconnected (" + code + (reason.isEmpty() ? "" : ", " + reason) + ")"));
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                handler.post(() -> retry(gen, "Can't reach the server: " + t.getMessage()));
            }
        });
    }

    private void retry(int gen, String why) {
        if (gen != generation) return;
        status = why + "; retrying in " + backoffMs / 1000 + " s";
        Log.w(TAG, status);
        handler.postDelayed(() -> {
            if (gen == generation) connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
    }

    private void ping(int gen) {
        handler.postDelayed(() -> {
            if (gen != generation || socket == null) return;
            socket.send("{\"type\":\"ping\"}");
            ping(gen);
        }, 15_000);
    }

    // ---------- what to play ----------

    private void onJson(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            switch (msg.optString("type")) {
                case "tts":
                    if ("stop".equals(msg.optString("state")) && msg.optBoolean("interrupted")) voice.flush();
                    break;
                case "play":
                    playClip(msg);
                    break;
                case "stop_audio":
                    stopClip();
                    break;
                case "pause_media":
                    if (clip != null && clip.isPlaying()) clip.pause();
                    break;
                case "resume_media":
                    if (clip != null && !clip.isPlaying()) clip.start();
                    break;
                case "set_loop":
                    loop = msg.optBoolean("loop");
                    if (clip != null) clip.setLooping(loop);
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "Bad message: " + text, e);
        }
    }

    /** A portal clip or a video's soundtrack, streamed from the server's media link. */
    private void playClip(JSONObject msg) {
        stopClip();
        String url = "http://" + host + ":" + msg.optInt("http_port", 8003) + msg.optString("path");
        String title = msg.optString("title", "clip");
        MediaPlayer player = new MediaPlayer();
        clip = player;
        try {
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            player.setDataSource(url);
            player.setLooping(loop);
            player.setOnPreparedListener(MediaPlayer::start);
            player.setOnCompletionListener(mp -> handler.post(() -> {
                if (clip == mp) stopClip();
            }));
            player.setOnErrorListener((mp, what, extra) -> {
                Log.w(TAG, "Can't play " + title + " (" + what + "/" + extra + ")");
                handler.post(() -> {
                    if (clip == mp) stopClip();
                });
                return true;
            });
            player.prepareAsync();
            Log.i(TAG, "Playing " + title);
        } catch (Exception e) {
            Log.w(TAG, "Can't play " + title, e);
            stopClip();
        }
    }

    private void stopClip() {
        if (clip == null) return;
        try {
            clip.release();
        } catch (Exception ignored) {
        }
        clip = null;
    }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, SetupActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
                .setContentTitle("BlimpMate Speaker")
                .setContentText("Playing the Blimp's sound")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }
}
