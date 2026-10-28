package com.blimpmate.remote;

import android.content.Context;
import android.graphics.Point;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;

/**
 * One viewer's session: the screen as hardware-encoded H.264 (ScreenEncoder,
 * scrcpy's approach) sent as binary packets over the agent's connection to the
 * stream server, and the viewer's taps, keys and text coming back over it.
 * Meanwhile a direct path (P2PLink, a WebRTC data channel) is tried; once it
 * opens, the packets go there from the next keyframe, and back through the
 * server if it closes. All methods run on the service's session thread,
 * except the encoder's packet callback.
 */
final class ScreenSession {
    private static final String TAG = "ScreenSession";
    // How often the viewer gets the encoder's stats
    private static final long STATS_MS = 2_000;
    // More than this waiting in the connection: drop frames until a keyframe,
    // so the picture stays current instead of falling behind
    private static final long MAX_BACKLOG_BYTES = 1024 * 1024;
    // More than this waiting on the direct path: it's slower than the server
    // (some routes barely move data), so it's dropped for the rest of the session
    private static final long MAX_P2P_BACKLOG_BYTES = 256 * 1024;
    // Adaptive bitrate, checked every RATE_MS: frames dropped (here or by the
    // server) or more than CONGESTED_BYTES waiting cuts it; RAISE_AFTER clear
    // checks in a row (under CLEAR_BYTES waiting) raise it back toward the preset
    private static final long RATE_MS = 1_000;
    private static final long CONGESTED_BYTES = 128 * 1024;
    private static final long CLEAR_BYTES = 16 * 1024;
    private static final int RAISE_AFTER = 3;
    private static final int MIN_KBPS = 300;
    // Packet header: flags, then the presentation time (see the stream server's screen.mjs)
    private static final int FLAG_CONFIG = 1;
    private static final int FLAG_KEY = 2;

    interface Listener {
        /** Sends a binary video packet; false when not connected. */
        boolean sendVideo(byte[] packet);

        /** Bytes still waiting to go out on the connection. */
        long backlog();

        /** A message for the viewer (ack, stats). */
        void sendToViewer(JSONObject message);

        /** A WebRTC signal for the viewer (the direct path's setup). */
        void sendSignal(JSONObject data);

        void onFailed(String error);

        /** Brings the Blimp app to the front; null on success. */
        String openBlimpApp();
    }

    /** Stream presets: the long side of the frame, frames per second, bitrate. */
    private static final class Quality {
        final int longSide, fps, kbps;

        Quality(int longSide, int fps, int kbps) {
            this.longSide = longSide;
            this.fps = fps;
            this.kbps = kbps;
        }

        static Quality of(String preset) {
            switch (preset) {
                case "low": return new Quality(854, 30, 1000);
                case "high": return new Quality(1920, 60, 8000);
                default: return new Quality(1280, 60, 4000);
            }
        }
    }

    private final Context context;
    private final Handler thread;
    private final Listener listener;
    private final ScreenEncoder encoder;
    private final P2PLink p2p;
    // Encoder thread: packets go over the direct path / switch to it at the next keyframe
    private volatile boolean usingP2P;
    private volatile boolean p2pPending;
    // Set when the direct path couldn't keep up: the server carries the rest of the session
    private volatile boolean p2pDropped;
    private Quality quality;
    private int[] frameSize;
    private boolean closed;
    // Encoder thread: set after frames were dropped, cleared by the next keyframe
    private volatile boolean waitKey;
    private volatile int framesSent;
    private volatile int framesDropped;
    private volatile long bytesSent;
    private int lastFrames;
    private int lastDropped;
    private long lastBytes;
    private long lastStatsAt;
    // Adaptive bitrate: the encoder's current target, and what the last check saw
    private int kbps;
    private int rateDropped;
    private int serverDrops;
    private int clearChecks;
    private long rateBytes;
    private long rateBacklog;

    ScreenSession(Context context, Handler thread, MediaProjection projection, String preset,
                  JSONArray iceServers, Listener listener) {
        this.context = context;
        this.thread = thread;
        this.listener = listener;
        this.quality = Quality.of(preset);
        int dpi = context.getResources().getDisplayMetrics().densityDpi;
        this.encoder = new ScreenEncoder(projection, dpi, new ScreenEncoder.Sink() {
            @Override
            public void onPacket(ByteBuffer data, boolean config, boolean key, long ptsUs) {
                onEncoded(data, config, key, ptsUs);
            }

            @Override
            public void onError(String error) {
                thread.post(() -> {
                    if (!closed) listener.onFailed(error);
                });
            }
        });
        this.p2p = new P2PLink(context, thread, iceServers, new P2PLink.Listener() {
            @Override
            public void sendSignal(JSONObject data) {
                if (!closed) listener.sendSignal(data);
            }

            @Override
            public void onOpenChanged(boolean open) {
                if (closed || p2pDropped) return;
                if (open) {
                    // Switch with a keyframe, so the viewer can start decoding from it
                    p2pPending = true;
                } else {
                    p2pPending = false;
                    usingP2P = false;
                }
                encoder.requestKeyFrame();
            }
        });
    }

    void start() {
        restartEncoder();
        p2p.start();
        lastStatsAt = SystemClock.elapsedRealtime();
        thread.postDelayed(statsTick, STATS_MS);
        thread.postDelayed(rateTick, RATE_MS);
    }

    void close() {
        if (closed) return;
        closed = true;
        thread.removeCallbacks(statsTick);
        thread.removeCallbacks(rateTick);
        encoder.release();
        p2p.close();
    }

    /** A WebRTC signal from the viewer for the direct path. */
    void onSignal(JSONObject data) {
        if (!closed) p2p.onSignal(data);
    }

    /** The screen turned: encode the new orientation. */
    void onScreenSizeChanged() {
        if (closed) return;
        int[] size = computeFrameSize();
        if (size[0] == frameSize[0] && size[1] == frameSize[1]) return;
        restartEncoder();
    }

    /** The server dropped frames for a viewer that fell behind and needs a keyframe. */
    void requestKeyFrame() {
        if (closed) return;
        serverDrops++;
        encoder.requestKeyFrame();
    }

    private void restartEncoder() {
        frameSize = computeFrameSize();
        waitKey = false;
        kbps = quality.kbps;
        clearChecks = 0;
        try {
            encoder.start(frameSize[0], frameSize[1], quality.fps, kbps * 1000);
        } catch (Exception e) {
            Log.w(TAG, "encoder start failed", e);
            listener.onFailed("Couldn't start the screen encoder: " + e.getMessage());
        }
    }

    // ---- packets (encoder thread) ----

    private void onEncoded(ByteBuffer data, boolean config, boolean key, long ptsUs) {
        // The path for this packet: direct once switched at a keyframe, the server otherwise
        if (usingP2P && !p2p.isOpen()) usingP2P = false;
        if (p2pPending && key && p2p.isOpen()) {
            p2pPending = false;
            usingP2P = true;
        }
        boolean direct = usingP2P;
        if (direct && p2p.buffered() > MAX_P2P_BACKLOG_BYTES) {
            dropP2P();
            direct = false;
        }
        long backlog = direct ? p2p.buffered() : listener.backlog();
        boolean essential = config || key;
        if (!essential && (waitKey || backlog > MAX_BACKLOG_BYTES)) {
            framesDropped++;
            if (!waitKey) {
                waitKey = true;
                encoder.requestKeyFrame();
            }
            return;
        }
        if (key) waitKey = false;
        byte[] packet = new byte[9 + data.remaining()];
        packet[0] = (byte) ((config ? FLAG_CONFIG : 0) | (key ? FLAG_KEY : 0));
        ByteBuffer.wrap(packet, 1, 8).putLong(ptsUs);
        data.get(packet, 9, data.remaining());
        boolean sent = direct ? p2p.send(packet) : listener.sendVideo(packet);
        if (direct && !sent) {
            // The direct path broke mid-packet: back through the server from a keyframe
            usingP2P = false;
            waitKey = true;
            encoder.requestKeyFrame();
            return;
        }
        if (sent && !config) {
            framesSent++;
            bytesSent += packet.length;
        }
    }

    // The direct path fell behind: back through the server from a keyframe, and
    // close the channel so the viewer takes the server's packets again
    private void dropP2P() {
        Log.i(TAG, "direct path too slow (" + p2p.buffered() / 1024 + " KB waiting); using the server");
        p2pDropped = true;
        p2pPending = false;
        usingP2P = false;
        waitKey = true;
        encoder.requestKeyFrame();
        thread.post(p2p::close);
    }

    // ---- adaptive bitrate ----

    // A fixed bitrate on a slower link only drops frames until the next
    // keyframe (stutter); a lower bitrate keeps every frame, a bit blurrier
    private final Runnable rateTick = new Runnable() {
        @Override
        public void run() {
            if (closed) return;
            int dropped = framesDropped;
            long bytes = bytesSent;
            long backlog = usingP2P ? p2p.buffered() : listener.backlog();
            // What the link carried since the last check: what went in, less what piled up
            int drainedKbps = (int) Math.max(0, (bytes - rateBytes - (backlog - rateBacklog)) * 8 / RATE_MS);
            boolean shrinking = backlog < rateBacklog;
            boolean congested = dropped != rateDropped || serverDrops > 0 || backlog > CONGESTED_BYTES;
            rateDropped = dropped;
            rateBytes = bytes;
            rateBacklog = backlog;
            serverDrops = 0;
            int next = kbps;
            if (congested) {
                clearChecks = 0;
                // Just under what the link carries; not again while the backlog drains
                if (!shrinking) {
                    int fit = drainedKbps > 0 ? drainedKbps * 85 / 100 : kbps / 2;
                    next = Math.max(MIN_KBPS, Math.min(kbps * 85 / 100, fit));
                }
            } else if (backlog < CLEAR_BYTES && kbps < quality.kbps && ++clearChecks >= RAISE_AFTER) {
                clearChecks = 0;
                next = Math.min(quality.kbps, kbps * 5 / 4);
            }
            if (next != kbps) {
                Log.i(TAG, "bitrate " + kbps + " -> " + next + " kbps (backlog " + backlog / 1024
                        + " KB, link " + drainedKbps + " kbps)");
                kbps = next;
                encoder.setBitRate(kbps * 1000);
            }
            thread.postDelayed(this, RATE_MS);
        }
    };

    // ---- stats for the viewer ----

    private final Runnable statsTick = new Runnable() {
        @Override
        public void run() {
            if (closed) return;
            long now = SystemClock.elapsedRealtime();
            double seconds = Math.max(0.001, (now - lastStatsAt) / 1000.0);
            int frames = framesSent;
            int dropped = framesDropped;
            long bytes = bytesSent;
            try {
                listener.sendToViewer(new JSONObject()
                        .put("t", "stats")
                        .put("encoder", encoder.encoderName())
                        .put("path", usingP2P ? "p2p" : "relay")
                        .put("fps", Math.round((frames - lastFrames) / seconds))
                        // frames skipped because the connection was backed up
                        .put("dropped", Math.round((dropped - lastDropped) / seconds))
                        .put("backlogKB", (usingP2P ? p2p.buffered() : listener.backlog()) / 1024)
                        .put("targetKbps", kbps)
                        .put("kbps", Math.round((bytes - lastBytes) * 8 / 1000.0 / seconds)));
            } catch (Exception ignored) {}
            lastFrames = frames;
            lastDropped = dropped;
            lastBytes = bytes;
            lastStatsAt = now;
            thread.postDelayed(this, STATS_MS);
        }
    };

    // ---- frame size ----

    /** The frame size: the screen's shape, its long side capped by the preset, multiples of 16. */
    private int[] computeFrameSize() {
        Point screen = screenSize();
        int longest = Math.max(screen.x, screen.y);
        float scale = Math.min(1f, quality.longSide / (float) longest);
        // Encoders want aligned sizes; 16 suits every H.264 encoder
        int w = Math.max(16, Math.round(screen.x * scale / 16f) * 16);
        int h = Math.max(16, Math.round(screen.y * scale / 16f) * 16);
        return new int[] {w, h};
    }

    private Point screenSize() {
        InputService input = InputService.get();
        if (input != null) return input.screenSize();
        android.view.Display display = context.getSystemService(android.hardware.display.DisplayManager.class)
                .getDisplay(android.view.Display.DEFAULT_DISPLAY);
        Point size = new Point();
        display.getRealSize(size);
        return size;
    }

    // ---- input from the viewer ----

    void onInput(JSONObject m) {
        if (closed) return;
        int id = m.optInt("id");
        String t = m.optString("t");
        InputService input = InputService.get();
        InputService.Done ack = (error) -> thread.post(() -> sendAck(id, error));
        switch (t) {
            case "keyframe":
                encoder.requestKeyFrame();
                return;
            case "quality":
                quality = Quality.of(m.optString("preset", "medium"));
                restartEncoder();
                sendAck(id, null);
                return;
            case "key":
                if ("blimp_app".equals(m.optString("key"))) {
                    sendAck(id, listener.openBlimpApp());
                    return;
                }
                break;
        }
        if (input == null) {
            sendAck(id, "Input control is off on the Blimp (turn on its accessibility service)");
            return;
        }
        switch (t) {
            case "gesture": {
                JSONArray pts = m.optJSONArray("points");
                if (pts == null) {
                    sendAck(id, "Bad gesture");
                    return;
                }
                float[][] points = new float[pts.length()][];
                for (int i = 0; i < pts.length(); i++) {
                    JSONArray p = pts.optJSONArray(i);
                    if (p == null || p.length() < 3) {
                        sendAck(id, "Bad gesture");
                        return;
                    }
                    points[i] = new float[] {(float) p.optDouble(0), (float) p.optDouble(1), (float) p.optDouble(2)};
                }
                input.gesture(points, ack);
                return;
            }
            case "key":
                input.key(m.optString("key"), ack);
                return;
            case "text":
                input.text(m.optString("text"), ack);
                return;
            default:
                sendAck(id, "Unknown input: " + t);
        }
    }

    private void sendAck(int id, String error) {
        if (closed) return;
        try {
            JSONObject ack = new JSONObject().put("t", "ack").put("id", id).put("ok", error == null);
            if (error != null) ack.put("error", error);
            listener.sendToViewer(ack);
        } catch (Exception ignored) {}
    }
}
