package com.l2dfacecontrol.host;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.SocketFactory;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Live camera view for the stream server's /camera page (protocol in the
 * stream server's camera.mjs). Exposed to the page as window.__nativeCameraViewRaw.
 *
 * Stays connected to the stream server (role=camera) and opens the camera only
 * while someone watches. Camera2 renders straight into the hardware H.264
 * encoder's input surface (no copies, no CPU work per frame); the packets go
 * out as binary WebSocket messages. The bitrate follows the connection: it is
 * cut when data piles up (here, or at the server for a slow page) and raised
 * again after a few clear seconds.
 *
 * The camera has the lowest priority: the page's own camera users (the AI's
 * photo tool, video calls) hold() it first, which closes it here, and
 * release() it after, which opens it again if someone still watches. Any other
 * app taking the camera gets it too: the stream pauses and resumes when the
 * camera is free.
 *
 * All state lives on one thread ("camera-view"), except the encoder's output loop.
 */
public final class CameraView {
    private static final String TAG = "CameraView";
    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;

    // The stream: 16:9 like the screens it is watched on (the camera crops its
    // 4:3 sensor), at most this size
    private static final int MAX_WIDTH = 1920;
    private static final int MAX_HEIGHT = 1080;
    private static final int TARGET_FPS = 30;
    private static final int I_FRAME_INTERVAL_S = 2;
    // Bitrate range (kbps) and the starting point
    private static final int MAX_KBPS = 5000;
    private static final int START_KBPS = 3000;
    private static final int MIN_KBPS = 350;
    // Adaptive bitrate, checked every RATE_MS
    private static final long RATE_MS = 1_000;
    private static final long CONGESTED_BYTES = 96 * 1024;
    private static final long CLEAR_BYTES = 16 * 1024;
    private static final int RAISE_AFTER = 3;
    // More than this waiting to go out: drop frames until a keyframe
    private static final long MAX_BACKLOG_BYTES = 512 * 1024;
    // Packet header flags (stream server's screen.mjs)
    private static final int FLAG_CONFIG = 1;
    private static final int FLAG_KEY = 2;
    private static final long MAX_RECONNECT_MS = 30_000;
    private static final long MAX_RETRY_MS = 10_000;
    // How long hold() callers should wait for the camera to close, at most
    private static final long CLOSE_TIMEOUT_MS = 3_000;

    private final Activity activity;
    private final CameraManager cameras;
    private final HandlerThread thread;
    private final Handler handler;
    private final OkHttpClient http;
    private final ConnectivityManager.NetworkCallback networkCallback;
    private final CameraManager.AvailabilityCallback availability;

    // ---- connection (camera-view thread) ----
    private String url = "";
    private String token = "";
    private WebSocket ws;
    private boolean connected;
    private long reconnectMs = 1000;
    private Runnable reconnectTask;

    // ---- what is wanted ----
    private boolean wanted; // someone watches (camera_start .. camera_stop)
    private final Map<String, String> holds = Collections.synchronizedMap(new LinkedHashMap<>());
    private final AtomicInteger nextHold = new AtomicInteger(1);
    private boolean foreground = true;

    // ---- the camera session (camera-view thread) ----
    private int generation;
    private String cameraId;
    private CameraDevice device;
    private CameraCaptureSession capture;
    private MediaCodec codec;
    private Surface inputSurface;
    private Thread encoderThread;
    private volatile boolean encoding;
    // Opening, open or closing: the camera isn't free for others
    private volatile boolean busy;
    private boolean closing;
    private Size size;
    private int rotation;
    private String state = "idle";
    private String reason = "";
    private String retryReason = "";
    private long retryMs = 1000;
    private Runnable retryTask;
    // Retry as soon as the camera is free again (someone else had it)
    private boolean retryOnAvailable;

    // ---- encoder thread / rate control ----
    private volatile WebSocket streamSocket;
    private volatile boolean waitKey;
    private volatile boolean firstPacket;
    private volatile int dropped;
    private int kbps = START_KBPS;
    private int clearTicks;
    private int lastDropped;
    private boolean serverCongested;
    private final Runnable rateTick = this::rateTick;

    public CameraView(Activity activity) {
        this.activity = activity;
        this.cameras = activity.getSystemService(CameraManager.class);
        thread = new HandlerThread("camera-view");
        thread.start();
        handler = new Handler(thread.getLooper());
        http = new OkHttpClient.Builder()
                .pingInterval(15, TimeUnit.SECONDS)
                .socketFactory(new SmallSendBufferSocketFactory())
                .build();

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    if (!connected && ws == null && !url.isEmpty()) {
                        reconnectMs = 1000;
                        connectNow();
                    }
                });
            }
        };
        try {
            activity.getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback, handler);
        } catch (Exception e) {
            Log.w(TAG, "no network callback", e);
        }

        // The camera came free (a photo or call ended, another app let go): try now
        availability = new CameraManager.AvailabilityCallback() {
            @Override
            public void onCameraAvailable(String id) {
                if (retryTask != null && retryOnAvailable && (cameraId == null || id.equals(cameraId))) retryNow();
            }
        };
        cameras.registerAvailabilityCallback(availability, handler);
    }

    // ---- JS interface ----

    /** Connect to the stream server (wss://host/ws); an empty url turns the view off. */
    @JavascriptInterface
    public void configure(String url, String token) {
        String u = url == null ? "" : url.trim();
        String t = token == null ? "" : token;
        handler.post(() -> {
            if (u.equals(this.url) && t.equals(this.token) && (ws != null || u.isEmpty())) return;
            this.url = u;
            this.token = t;
            disconnect("reconfigured");
            reconnectMs = 1000;
            if (!u.isEmpty()) connectNow();
        });
    }

    /**
     * Takes the camera away from the view (reason: photo | call). Returns an id
     * for release(); poll isFree() until the camera is closed.
     */
    @JavascriptInterface
    public String hold(String reason) {
        String id = "h" + nextHold.getAndIncrement();
        holds.put(id, reason == null || reason.isEmpty() ? "busy" : reason);
        handler.post(this::update);
        return id;
    }

    @JavascriptInterface
    public void release(String id) {
        if (holds.remove(id) != null) handler.post(this::update);
    }

    /** True when this view isn't using the camera (closed, not opening). */
    @JavascriptInterface
    public boolean isFree() {
        return !busy;
    }

    @JavascriptInterface
    public long closeTimeoutMs() {
        return CLOSE_TIMEOUT_MS;
    }

    @JavascriptInterface
    public String getStatus() {
        try {
            return new JSONObject()
                    .put("connected", connected)
                    .put("watching", wanted)
                    .put("state", state)
                    .put("reason", reason)
                    .put("holds", holds.size())
                    .put("kbps", kbps)
                    .put("busy", busy)
                    .toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    // ---- activity lifecycle ----

    /** A new page: holds from the old one are gone with it. */
    public void onPageStarted() {
        if (!holds.isEmpty()) {
            holds.clear();
            handler.post(this::update);
        }
    }

    public void onForeground(boolean inFront) {
        handler.post(() -> {
            foreground = inFront;
            if (inFront && retryTask != null) retryNow();
        });
    }

    public void shutdown() {
        handler.post(() -> {
            disconnect("app closed");
            try {
                activity.getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
            cameras.unregisterAvailabilityCallback(availability);
            thread.quitSafely();
        });
    }

    // ---- what should run (camera-view thread) ----

    private void update() {
        boolean held = !holds.isEmpty();
        boolean shouldRun = connected && wanted && !held;
        if (!shouldRun) cancelRetry();
        if (shouldRun && device == null && !busy && retryTask == null) {
            openCamera();
        } else if (!shouldRun && busy) {
            closeCamera();
        }
        // What the pages see
        if (!wanted || !connected) {
            setState("idle", "");
        } else if (held) {
            setState("paused", firstHoldReason());
        } else if (retryTask != null) {
            setState("error", retryReason);
        } else if (busy && !firstPacket) {
            setState("starting", "");
        }
    }

    private String firstHoldReason() {
        synchronized (holds) {
            for (String r : holds.values()) return r;
        }
        return "busy";
    }

    private void setState(String s, String r) {
        boolean changed = !s.equals(state) || !r.equals(reason);
        state = s;
        reason = r;
        if (changed) sendState();
    }

    private void sendState() {
        try {
            JSONObject msg = new JSONObject().put("type", "camera_state").put("state", state);
            if (!reason.isEmpty()) msg.put("reason", reason);
            if ("streaming".equals(state) && size != null) {
                msg.put("width", size.getWidth()).put("height", size.getHeight())
                        .put("rotation", rotation).put("kbps", kbps).put("fps", TARGET_FPS);
            }
            send(msg);
        } catch (Exception ignored) {}
    }

    // ---- camera (camera-view thread) ----

    private void openCamera() {
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            retryLater("The Blimp app has no camera permission", false, false);
            return;
        }
        int gen = ++generation;
        try {
            cameraId = pickCamera();
            if (cameraId == null) {
                retryLater("No camera found", false, false);
                return;
            }
            CameraCharacteristics chars = cameras.getCameraCharacteristics(cameraId);
            size = pickSize(chars);
            rotation = pictureRotation(chars);
            Range<Integer> fps = pickFpsRange(chars);
            startEncoder(size);
            busy = true;
            firstPacket = false;
            setState("starting", "");
            Log.i(TAG, "opening camera " + cameraId + " at " + size + ", " + fps + " fps, rotation " + rotation);
            cameras.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    if (gen != generation || closing) {
                        camera.close();
                        return;
                    }
                    device = camera;
                    if (!connected || !wanted || !holds.isEmpty()) {
                        closeCamera();
                        return;
                    }
                    startCapture(gen, fps);
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    // Someone with a higher priority took the camera
                    if (gen != generation) return;
                    Log.i(TAG, "camera taken by another user");
                    device = camera;
                    closeCamera();
                    retryLater("The camera is in use by another app", true, true);
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    if (gen != generation) return;
                    Log.w(TAG, "camera error " + error);
                    device = camera;
                    closeCamera();
                    boolean taken = error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE;
                    retryLater(describe(error), true, taken);
                }

                @Override
                public void onClosed(CameraDevice camera) {
                    if (gen == generation) onCameraClosed();
                }
            }, handler);
        } catch (CameraAccessException e) {
            stopEncoder();
            busy = false;
            retryLater(e.getReason() == CameraAccessException.CAMERA_DISABLED && !foreground
                    ? "The Blimp app isn't on screen" : "Camera unavailable: " + e.getMessage(), true,
                    e.getReason() == CameraAccessException.CAMERA_IN_USE || e.getReason() == CameraAccessException.MAX_CAMERAS_IN_USE);
        } catch (Exception e) {
            Log.w(TAG, "open failed", e);
            stopEncoder();
            busy = false;
            retryLater("Camera failed: " + e.getMessage(), true, false);
        }
    }

    private void startCapture(int gen, Range<Integer> fps) {
        try {
            device.createCaptureSession(Collections.singletonList(inputSurface), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    if (gen != generation || device == null || closing) return;
                    capture = session;
                    try {
                        CaptureRequest.Builder req = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                        req.addTarget(inputSurface);
                        req.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
                        if (fps != null) req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps);
                        int[] afModes = cameras.getCameraCharacteristics(cameraId)
                                .get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                        if (contains(afModes, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO)) {
                            req.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                        }
                        session.setRepeatingRequest(req.build(), null, handler);
                        retryMs = 1000;
                    } catch (Exception e) {
                        Log.w(TAG, "capture failed", e);
                        closeCamera();
                        retryLater("Camera failed: " + e.getMessage(), true, false);
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession session) {
                    if (gen != generation) return;
                    closeCamera();
                    retryLater("The camera refused the stream format", true, false);
                }
            }, handler);
        } catch (Exception e) {
            Log.w(TAG, "session failed", e);
            closeCamera();
            retryLater("Camera failed: " + e.getMessage(), true, false);
        }
    }

    private void closeCamera() {
        handler.removeCallbacks(rateTick);
        encoding = false;
        if (device == null) {
            // Still opening: onOpened closes it (closing makes it skip the start)
            if (busy) {
                closing = true;
                int gen = generation;
                handler.postDelayed(() -> {
                    if (gen == generation && closing) onCameraClosed();
                }, 4_000);
            }
            return;
        }
        closing = true;
        if (capture != null) {
            try { capture.close(); } catch (Exception ignored) {}
            capture = null;
        }
        CameraDevice d = device;
        device = null;
        try { d.close(); } catch (Exception ignored) {}
        // onClosed() finishes the job
        int gen = generation;
        handler.postDelayed(() -> {
            if (gen == generation && closing) onCameraClosed();
        }, 2_000);
    }

    private void onCameraClosed() {
        if (!busy) return;
        stopEncoder();
        closing = false;
        busy = false;
        generation++;
        Log.i(TAG, "camera closed");
        update();
    }

    private void retryLater(String why, boolean backoff, boolean onAvailable) {
        Log.w(TAG, why + "; retrying in " + retryMs + " ms");
        cancelRetry();
        retryReason = why;
        retryOnAvailable = onAvailable;
        retryTask = this::retryNow;
        handler.postDelayed(retryTask, retryMs);
        if (backoff) retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        else retryMs = MAX_RETRY_MS;
        if (!holds.isEmpty()) setState("paused", firstHoldReason());
        else if (wanted && connected) setState("error", why);
    }

    private void retryNow() {
        cancelRetry();
        update();
    }

    private void cancelRetry() {
        if (retryTask != null) {
            handler.removeCallbacks(retryTask);
            retryTask = null;
        }
    }

    private static String describe(int error) {
        switch (error) {
            case CameraDevice.StateCallback.ERROR_CAMERA_IN_USE: return "The camera is in use";
            case CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE: return "Too many cameras in use";
            case CameraDevice.StateCallback.ERROR_CAMERA_DISABLED: return "The camera is disabled (is the Blimp app on screen?)";
            case CameraDevice.StateCallback.ERROR_CAMERA_DEVICE: return "The camera stopped working";
            case CameraDevice.StateCallback.ERROR_CAMERA_SERVICE: return "The camera service failed";
            default: return "Camera error " + error;
        }
    }

    // The camera the photo tool and calls use ("user" facing): front, else external, else any
    private String pickCamera() throws CameraAccessException {
        String[] ids = cameras.getCameraIdList();
        String external = null, back = null;
        for (String id : ids) {
            Integer facing = cameras.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (facing == null) continue;
            if (facing == CameraMetadata.LENS_FACING_FRONT) return id;
            if (facing == CameraMetadata.LENS_FACING_EXTERNAL && external == null) external = id;
            if (facing == CameraMetadata.LENS_FACING_BACK && back == null) back = id;
        }
        if (external != null) return external;
        if (back != null) return back;
        return ids.length > 0 ? ids[0] : null;
    }

    // The largest 16:9 size within MAX_WIDTH x MAX_HEIGHT that the encoder takes;
    // else the largest other size
    private Size pickSize(CameraCharacteristics chars) {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(MediaCodec.class);
        if (sizes == null || sizes.length == 0) sizes = map == null ? null : map.getOutputSizes(ImageFormat.PRIVATE);
        if (sizes == null || sizes.length == 0) return new Size(1280, 720);
        MediaCodecInfo.VideoCapabilities caps = encoderCaps();
        Size bestWide = null, bestAny = null;
        for (Size s : sizes) {
            int w = s.getWidth(), h = s.getHeight();
            if (w > MAX_WIDTH || h > MAX_HEIGHT) continue;
            if (caps != null && !caps.isSizeSupported(w, h)) continue;
            long area = (long) w * h;
            if (Math.abs(w * 9 - h * 16) <= 16) {
                if (bestWide == null || area > (long) bestWide.getWidth() * bestWide.getHeight()) bestWide = s;
            }
            if (bestAny == null || area > (long) bestAny.getWidth() * bestAny.getHeight()) bestAny = s;
        }
        // A small 16:9 size loses to a much larger other one
        if (bestWide != null && (bestAny == null || (long) bestWide.getWidth() * bestWide.getHeight() * 2
                >= (long) bestAny.getWidth() * bestAny.getHeight())) return bestWide;
        if (bestAny != null) return bestAny;
        return sizes[sizes.length - 1];
    }

    private static MediaCodecInfo.VideoCapabilities encoderCaps() {
        try {
            MediaCodec c = MediaCodec.createEncoderByType(MIME);
            try {
                return c.getCodecInfo().getCapabilitiesForType(MIME).getVideoCapabilities();
            } finally {
                c.release();
            }
        } catch (Exception e) {
            return null;
        }
    }

    // Up to TARGET_FPS; the widest range there (lets exposure stretch in low light),
    // but not below 15 fps
    private static Range<Integer> pickFpsRange(CameraCharacteristics chars) {
        Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null || ranges.length == 0) return null;
        int bestUpper = 0;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() <= TARGET_FPS) bestUpper = Math.max(bestUpper, r.getUpper());
        }
        if (bestUpper == 0) return null;
        Range<Integer> best = null;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() != bestUpper) continue;
            boolean ok = r.getLower() >= 15;
            if (best == null) best = r;
            else if (ok && (best.getLower() < 15 || r.getLower() < best.getLower())) best = r;
            else if (!ok && best.getLower() < 15 && r.getLower() > best.getLower()) best = r;
        }
        return best;
    }

    // How far the viewer turns the picture to show it upright, as the Blimp's screen is held
    private int pictureRotation(CameraCharacteristics chars) {
        Integer sensor = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
        int s = sensor == null ? 0 : sensor;
        int display = 0;
        try {
            switch (activity.getWindowManager().getDefaultDisplay().getRotation()) {
                case Surface.ROTATION_90: display = 90; break;
                case Surface.ROTATION_180: display = 180; break;
                case Surface.ROTATION_270: display = 270; break;
                default: display = 0;
            }
        } catch (Exception ignored) {}
        if (facing != null && facing == CameraMetadata.LENS_FACING_FRONT) return (s + display) % 360;
        return (s - display + 360) % 360;
    }

    private static boolean contains(int[] values, int v) {
        if (values == null) return false;
        for (int x : values) if (x == v) return true;
        return false;
    }

    // ---- encoder ----

    private void startEncoder(Size s) throws IOException {
        stopEncoder();
        // A new session starts from the last rate the link carried, but not too low to climb back
        kbps = Math.min(Math.max(kbps, (START_KBPS + MIN_KBPS) / 2), MAX_KBPS);
        MediaCodec c = MediaCodec.createEncoderByType(MIME);
        try {
            c.configure(format(s, true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Exception e) {
            // Some encoders reject the profile: the default one then
            Log.i(TAG, "High profile refused (" + e.getMessage() + "), using the default");
            c.release();
            c = MediaCodec.createEncoderByType(MIME);
            c.configure(format(s, false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        codec = c;
        inputSurface = c.createInputSurface();
        c.start();
        streamSocket = ws;
        waitKey = false;
        dropped = 0;
        lastDropped = 0;
        clearTicks = 0;
        serverCongested = false;
        encoding = true;
        MediaCodec mine = c;
        encoderThread = new Thread(() -> encodeLoop(mine), "camera-encoder");
        encoderThread.start();
        handler.removeCallbacks(rateTick);
        handler.postDelayed(rateTick, RATE_MS);
        Log.i(TAG, "encoding " + s + " at " + kbps + " kbps with " + c.getName());
    }

    private MediaFormat format(Size s, boolean highProfile) {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, s.getWidth(), s.getHeight());
        f.setInteger(MediaFormat.KEY_BIT_RATE, kbps * 1000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, TARGET_FPS);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_S);
        f.setInteger(MediaFormat.KEY_PRIORITY, 0);
        if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LATENCY, 1);
        if (highProfile && supportsHigh()) {
            f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh);
            f.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41);
        }
        return f;
    }

    private static boolean supportsHigh() {
        try {
            for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
                if (!info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    if (!type.equalsIgnoreCase(MIME)) continue;
                    for (MediaCodecInfo.CodecProfileLevel pl : info.getCapabilitiesForType(MIME).profileLevels) {
                        if (pl.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh) return true;
                    }
                    return false; // the first AVC encoder is the one createEncoderByType picks
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private void stopEncoder() {
        encoding = false;
        handler.removeCallbacks(rateTick);
        if (encoderThread != null) {
            try { encoderThread.join(1000); } catch (InterruptedException ignored) {}
            encoderThread = null;
        }
        if (codec != null) {
            try { codec.stop(); } catch (Exception ignored) {}
            codec.release();
            codec = null;
        }
        if (inputSurface != null) {
            inputSurface.release();
            inputSurface = null;
        }
    }

    private void encodeLoop(MediaCodec c) {
        Looper.prepare();
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (encoding) {
                int id = c.dequeueOutputBuffer(info, 100_000);
                if (id < 0) continue;
                try {
                    if (info.size > 0) {
                        ByteBuffer buffer = c.getOutputBuffer(id);
                        if (buffer != null) {
                            buffer.position(info.offset).limit(info.offset + info.size);
                            onPacket(buffer, (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0,
                                    (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0, info.presentationTimeUs);
                        }
                    }
                } finally {
                    c.releaseOutputBuffer(id, false);
                }
            }
        } catch (IllegalStateException e) {
            if (encoding) {
                Log.w(TAG, "encoder stopped", e);
                handler.post(() -> {
                    if (codec == c) {
                        closeCamera();
                        retryLater("The video encoder stopped", true, false);
                    }
                });
            }
        }
    }

    // Encoder thread
    private void onPacket(ByteBuffer data, boolean config, boolean key, long ptsUs) {
        WebSocket socket = streamSocket;
        if (socket == null) return;
        boolean essential = config || key;
        if (!essential && (waitKey || socket.queueSize() > MAX_BACKLOG_BYTES)) {
            if (!waitKey) {
                waitKey = true;
                requestKeyFrame();
            }
            dropped++;
            return;
        }
        if (key) waitKey = false;
        byte[] packet = new byte[9 + data.remaining()];
        packet[0] = (byte) ((config ? FLAG_CONFIG : 0) | (key ? FLAG_KEY : 0));
        ByteBuffer.wrap(packet, 1, 8).putLong(ptsUs);
        data.get(packet, 9, data.remaining());
        socket.send(ByteString.of(packet));
        if (!config && !firstPacket) {
            firstPacket = true;
            handler.post(() -> {
                if (busy && !closing) setState("streaming", "");
            });
        }
    }

    private void requestKeyFrame() {
        MediaCodec c = codec;
        if (c == null) return;
        Bundle params = new Bundle();
        params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try { c.setParameters(params); } catch (Exception ignored) {}
    }

    // Camera-view thread: follow the connection's capacity
    private void rateTick() {
        if (codec == null || !encoding) return;
        WebSocket socket = streamSocket;
        long backlog = socket == null ? 0 : socket.queueSize();
        int drops = dropped - lastDropped;
        lastDropped = dropped;
        int next = kbps;
        if (backlog > CONGESTED_BYTES || drops > 0 || serverCongested) {
            next = Math.max(MIN_KBPS, kbps * 7 / 10);
            clearTicks = 0;
        } else if (backlog < CLEAR_BYTES && ++clearTicks >= RAISE_AFTER) {
            next = Math.min(MAX_KBPS, kbps * 6 / 5);
            clearTicks = 0;
        }
        serverCongested = false;
        if (next != kbps) {
            kbps = next;
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, kbps * 1000);
            try { codec.setParameters(params); } catch (Exception ignored) {}
            if ("streaming".equals(state)) sendState();
        }
        handler.postDelayed(rateTick, RATE_MS);
    }

    // ---- connection to the stream server (camera-view thread) ----

    private void connectNow() {
        if (reconnectTask != null) {
            handler.removeCallbacks(reconnectTask);
            reconnectTask = null;
        }
        if (url.isEmpty()) return;
        HttpUrl base = HttpUrl.parse(url.replaceFirst("^wss://", "https://").replaceFirst("^ws://", "http://"));
        if (base == null) {
            Log.w(TAG, "bad stream server address: " + url);
            return;
        }
        HttpUrl target = base.newBuilder()
                .removeAllQueryParameters("role").removeAllQueryParameters("token")
                .addQueryParameter("role", "camera").addQueryParameter("token", token).build();
        ws = http.newWebSocket(new Request.Builder().url(target).build(), new Listener());
    }

    private void disconnect(String why) {
        wanted = false;
        connected = false;
        if (ws != null) {
            WebSocket old = ws;
            ws = null;
            old.close(1000, why);
        }
        streamSocket = null;
        update();
    }

    private void onClosed(WebSocket socket, int code, String why) {
        if (socket != ws) return;
        ws = null;
        connected = false;
        wanted = false;
        streamSocket = null;
        update();
        if (url.isEmpty()) return;
        // 4001: wrong token; 4002: another device with the same token took over
        long delay = code == 4001 ? 60_000 : code == 4002 ? 30_000 : reconnectMs;
        Log.i(TAG, "stream server closed (" + code + " " + why + "); retrying in " + delay / 1000 + " s");
        reconnectTask = this::connectNow;
        handler.postDelayed(reconnectTask, delay);
        reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
    }

    private void onServerMessage(JSONObject msg) {
        switch (msg.optString("type")) {
            case "welcome":
                connected = true;
                reconnectMs = 1000;
                streamSocket = ws;
                Log.i(TAG, "stream server connected");
                sendInfo();
                // The server may have missed changes while the link was down
                sendState();
                update();
                break;
            case "camera_start":
                wanted = true;
                retryMs = 1000;
                update();
                break;
            case "camera_stop":
                wanted = false;
                update();
                break;
            case "keyframe":
                requestKeyFrame();
                break;
            case "congestion":
                serverCongested = true;
                break;
        }
    }

    private void send(JSONObject msg) {
        if (ws != null) ws.send(msg.toString());
    }

    private void sendInfo() {
        try {
            send(new JSONObject().put("type", "info").put("device", new JSONObject()
                    .put("model", Build.MODEL)
                    .put("manufacturer", Build.MANUFACTURER)
                    .put("android", Build.VERSION.RELEASE)));
        } catch (Exception ignored) {}
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
        public void onClosing(WebSocket socket, int code, String why) {
            socket.close(1000, null);
            handler.post(() -> CameraView.this.onClosed(socket, code, why));
        }

        @Override
        public void onFailure(WebSocket socket, Throwable t, Response response) {
            String why = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            handler.post(() -> CameraView.this.onClosed(socket, 1006, why));
        }
    }

    /**
     * Sockets with a small send buffer, so a stream faster than the link waits
     * in OkHttp's queue (which the rate control sees) rather than in the kernel.
     */
    private static final class SmallSendBufferSocketFactory extends SocketFactory {
        private static final int SEND_BUFFER_BYTES = 64 * 1024;
        private final SocketFactory base = SocketFactory.getDefault();

        private static Socket small(Socket s) throws IOException {
            s.setSendBufferSize(SEND_BUFFER_BYTES);
            return s;
        }

        @Override public Socket createSocket() throws IOException { return small(base.createSocket()); }
        @Override public Socket createSocket(String host, int port) throws IOException { return small(base.createSocket(host, port)); }
        @Override public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            return small(base.createSocket(host, port, localHost, localPort));
        }
        @Override public Socket createSocket(InetAddress host, int port) throws IOException { return small(base.createSocket(host, port)); }
        @Override public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            return small(base.createSocket(address, port, localAddress, localPort));
        }
    }
}
