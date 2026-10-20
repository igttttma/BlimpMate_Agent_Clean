package com.blimpmate.remote;

import android.content.Context;
import android.graphics.Point;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RTCStats;
import org.webrtc.RtpCapabilities;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * One viewer's session: the screen as a WebRTC video track (this side sends
 * the offer) and an "input" data channel for the viewer's taps, keys and text.
 * All methods run on the service's session thread.
 */
final class ScreenSession {
    private static final String TAG = "ScreenSession";
    // The viewer ends the session if ICE stays disconnected this long
    private static final long DISCONNECT_GRACE_MS = 10_000;
    // How often the viewer gets the encoder's stats (codec, hardware or not, what limits it)
    private static final long STATS_MS = 2_000;

    interface Listener {
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
                case "low": return new Quality(854, 15, 800);
                case "high": return new Quality(1920, 30, 6000);
                default: return new Quality(1280, 30, 2500);
            }
        }
    }

    private final Context context;
    private final Handler thread;
    private final PeerConnectionFactory factory;
    private final EglBase egl;
    private final MediaProjection projection;
    private final List<PeerConnection.IceServer> iceServers;
    private final Listener listener;

    private SurfaceTextureHelper helper;
    private ProjectionCapturer capturer;
    private VideoSource source;
    private PeerConnection pc;
    private RtpSender sender;
    private DataChannel channel;
    private Quality quality = Quality.of("medium");
    private int[] captureSize;
    private final List<IceCandidate> pendingCandidates = new ArrayList<>();
    private boolean closed;
    private Runnable disconnectTimer;

    ScreenSession(Context context, Handler thread, PeerConnectionFactory factory, EglBase egl,
                  MediaProjection projection, List<PeerConnection.IceServer> iceServers, Listener listener) {
        this.context = context;
        this.thread = thread;
        this.factory = factory;
        this.egl = egl;
        this.projection = projection;
        this.iceServers = iceServers;
        this.listener = listener;
    }

    void start() {
        // Aligned timestamps: the same clock as the capturer's re-sent frames
        helper = SurfaceTextureHelper.create("ScreenCapture", egl.getEglBaseContext(), true);
        capturer = new ProjectionCapturer(projection, context.getResources().getDisplayMetrics().densityDpi);
        source = factory.createVideoSource(true);
        capturer.initialize(helper, context, source.getCapturerObserver());
        captureSize = frameSize();
        capturer.startCapture(captureSize[0], captureSize[1], quality.fps);
        VideoTrack track = factory.createVideoTrack("screen", source);

        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        pc = factory.createPeerConnection(config, new PcObserver());
        if (pc == null) {
            listener.onFailed("Could not create the WebRTC connection");
            return;
        }
        sender = pc.addTrack(track, Collections.singletonList("screen"));
        for (RtpTransceiver t : pc.getTransceivers()) {
            t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY);
            if (t.getMediaType() == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) preferH264(t);
        }
        applyEncoding();

        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true;
        channel = pc.createDataChannel("input", init);
        channel.registerObserver(new ChannelObserver());
        thread.postDelayed(statsTick, STATS_MS);

        pc.createOffer(new SdpAdapter("create offer") {
            @Override
            public void onCreateSuccess(SessionDescription offer) {
                thread.post(() -> {
                    if (closed) return;
                    pc.setLocalDescription(new SdpAdapter("set offer"), offer);
                    listener.sendSignal(description(offer));
                });
            }
        }, new MediaConstraints());
    }

    /** A signal from the viewer: its answer, or an ICE candidate. */
    void onSignal(JSONObject data) {
        if (closed || pc == null) return;
        JSONObject d = data.optJSONObject("description");
        JSONObject c = data.optJSONObject("candidate");
        if (d != null && "answer".equals(d.optString("type"))) {
            SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, d.optString("sdp"));
            pc.setRemoteDescription(new SdpAdapter("set answer") {
                @Override
                public void onSetSuccess() {
                    thread.post(() -> {
                        if (closed) return;
                        for (IceCandidate ic : pendingCandidates) pc.addIceCandidate(ic);
                        pendingCandidates.clear();
                    });
                }
            }, answer);
        } else if (c != null && !c.optString("candidate").isEmpty()) {
            IceCandidate ic = new IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate"));
            if (pc.getRemoteDescription() == null) pendingCandidates.add(ic);
            else pc.addIceCandidate(ic);
        }
    }

    /** The screen turned: capture the new orientation. */
    void onScreenSizeChanged() {
        if (closed || capturer == null) return;
        int[] size = frameSize();
        if (size[0] == captureSize[0] && size[1] == captureSize[1]) return;
        captureSize = size;
        capturer.changeCaptureFormat(size[0], size[1], quality.fps);
    }

    void close() {
        if (closed) return;
        closed = true;
        if (disconnectTimer != null) thread.removeCallbacks(disconnectTimer);
        thread.removeCallbacks(statsTick);
        if (channel != null) {
            channel.unregisterObserver();
            channel.close();
            channel.dispose();
            channel = null;
        }
        if (pc != null) {
            pc.dispose();
            pc = null;
        }
        if (capturer != null) {
            capturer.stopCapture();
            capturer.dispose();
            capturer = null;
        }
        if (source != null) {
            source.dispose();
            source = null;
        }
        if (helper != null) {
            helper.dispose();
            helper = null;
        }
    }

    // ---- quality ----

    /** The frame size: the screen's shape, its long side capped by the preset, even numbers. */
    private int[] frameSize() {
        Point screen = screenSize();
        int longest = Math.max(screen.x, screen.y);
        float scale = Math.min(1f, quality.longSide / (float) longest);
        int w = Math.round(screen.x * scale) & ~1;
        int h = Math.round(screen.y * scale) & ~1;
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

    private void setQuality(String preset) {
        quality = Quality.of(preset);
        applyEncoding();
        captureSize = frameSize();
        capturer.changeCaptureFormat(captureSize[0], captureSize[1], quality.fps);
    }

    /**
     * H.264 first: Android devices encode it in hardware (MediaCodec), while VP8,
     * WebRTC's default, usually falls back to software on the CPU and drops frames.
     * The other codecs stay listed as fallbacks.
     */
    private void preferH264(RtpTransceiver transceiver) {
        List<RtpCapabilities.CodecCapability> codecs = new ArrayList<>();
        List<RtpCapabilities.CodecCapability> others = new ArrayList<>();
        for (RtpCapabilities.CodecCapability c :
                factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs) {
            ("H264".equalsIgnoreCase(c.name) ? codecs : others).add(c);
        }
        if (codecs.isEmpty()) {
            Log.w(TAG, "No hardware H.264 encoder on this device; WebRTC picks the codec");
            return;
        }
        codecs.addAll(others);
        transceiver.setCodecPreferences(codecs);
    }

    // ---- encoder stats for the viewer ----

    private final Runnable statsTick = new Runnable() {
        @Override
        public void run() {
            if (closed) return;
            sendStats();
            thread.postDelayed(this, STATS_MS);
        }
    };

    private void sendStats() {
        pc.getStats(report -> {
            JSONObject stats = new JSONObject();
            try {
                for (RTCStats s : report.getStatsMap().values()) {
                    if (!"outbound-rtp".equals(s.getType()) || !"video".equals(s.getMembers().get("kind"))) continue;
                    java.util.Map<String, Object> m = s.getMembers();
                    stats.put("t", "stats");
                    stats.put("encoder", String.valueOf(m.get("encoderImplementation")));
                    stats.put("limit", String.valueOf(m.get("qualityLimitationReason")));
                    if (m.get("framesPerSecond") != null) stats.put("fps", m.get("framesPerSecond"));
                    RTCStats codec = report.getStatsMap().get(String.valueOf(m.get("codecId")));
                    if (codec != null) stats.put("codec", String.valueOf(codec.getMembers().get("mimeType")));
                }
            } catch (Exception ignored) {}
            if (stats.length() > 0) thread.post(() -> send(stats));
        });
    }

    private void applyEncoding() {
        if (sender == null) return;
        RtpParameters params = sender.getParameters();
        // Text and UI stay sharp; on a slow link the frame rate drops instead
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
        for (RtpParameters.Encoding e : params.encodings) {
            e.maxBitrateBps = quality.kbps * 1000;
            e.maxFramerate = quality.fps;
        }
        sender.setParameters(params);
    }

    // ---- input from the viewer ----

    private void onInput(JSONObject m) {
        int id = m.optInt("id");
        String t = m.optString("t");
        InputService input = InputService.get();
        InputService.Done ack = (error) -> thread.post(() -> sendAck(id, error));
        switch (t) {
            case "quality":
                setQuality(m.optString("preset", "medium"));
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
        JSONObject ack = new JSONObject();
        try {
            ack.put("t", "ack");
            ack.put("id", id);
            ack.put("ok", error == null);
            if (error != null) ack.put("error", error);
        } catch (Exception ignored) {}
        send(ack);
    }

    private void send(JSONObject message) {
        if (closed || channel == null || channel.state() != DataChannel.State.OPEN) return;
        byte[] bytes = message.toString().getBytes(StandardCharsets.UTF_8);
        channel.send(new DataChannel.Buffer(ByteBuffer.wrap(bytes), false));
    }

    // ---- WebRTC callbacks (on WebRTC's threads; moved to the session thread) ----

    private static JSONObject description(SessionDescription sd) {
        JSONObject d = new JSONObject();
        try {
            JSONObject desc = new JSONObject();
            desc.put("type", sd.type.canonicalForm());
            desc.put("sdp", sd.description);
            d.put("description", desc);
        } catch (Exception ignored) {}
        return d;
    }

    private final class PcObserver implements PeerConnection.Observer {
        @Override
        public void onIceCandidate(IceCandidate c) {
            JSONObject data = new JSONObject();
            try {
                JSONObject cand = new JSONObject();
                cand.put("candidate", c.sdp);
                cand.put("sdpMid", c.sdpMid);
                cand.put("sdpMLineIndex", c.sdpMLineIndex);
                data.put("candidate", cand);
            } catch (Exception ignored) {}
            thread.post(() -> {
                if (!closed) listener.sendSignal(data);
            });
        }

        @Override
        public void onConnectionChange(PeerConnection.PeerConnectionState state) {
            Log.i(TAG, "connection " + state);
            thread.post(() -> {
                if (closed) return;
                if (disconnectTimer != null) {
                    thread.removeCallbacks(disconnectTimer);
                    disconnectTimer = null;
                }
                if (state == PeerConnection.PeerConnectionState.FAILED) {
                    listener.onFailed("The connection to the viewer failed");
                } else if (state == PeerConnection.PeerConnectionState.DISCONNECTED) {
                    disconnectTimer = () -> {
                        if (!closed) listener.onFailed("The connection to the viewer was lost");
                    };
                    thread.postDelayed(disconnectTimer, DISCONNECT_GRACE_MS);
                }
            });
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
        @Override public void onIceConnectionReceivingChange(boolean receiving) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel dc) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
    }

    private final class ChannelObserver implements DataChannel.Observer {
        @Override
        public void onMessage(DataChannel.Buffer buffer) {
            if (buffer.binary) return;
            ByteBuffer data = buffer.data;
            byte[] bytes = new byte[data.remaining()];
            data.get(bytes);
            String text = new String(bytes, StandardCharsets.UTF_8);
            thread.post(() -> {
                if (closed) return;
                try {
                    onInput(new JSONObject(text));
                } catch (Exception e) {
                    Log.w(TAG, "bad input message", e);
                }
            });
        }

        @Override public void onBufferedAmountChange(long previous) {}
        @Override public void onStateChange() {}
    }

    private class SdpAdapter implements SdpObserver {
        private final String what;

        SdpAdapter(String what) {
            this.what = what;
        }

        @Override public void onCreateSuccess(SessionDescription sd) {}
        @Override public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String error) {
            fail(error);
        }

        @Override
        public void onSetFailure(String error) {
            fail(error);
        }

        private void fail(String error) {
            Log.e(TAG, what + " failed: " + error);
            thread.post(() -> {
                if (!closed) listener.onFailed("WebRTC: " + what + " failed: " + error);
            });
        }
    }
}
