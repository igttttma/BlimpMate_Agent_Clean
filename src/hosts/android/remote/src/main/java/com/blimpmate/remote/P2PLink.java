package com.blimpmate.remote;

import android.content.Context;
import android.os.Handler;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * The direct path to one viewer: a WebRTC data channel (this side offers; the
 * stream server relays the signals) that carries the H.264 packets when it
 * connects. Only the data channel: the video itself stays scrcpy's encoder.
 * Methods run on the session thread; send() and isOpen() also on the encoder's.
 */
final class P2PLink {
    private static final String TAG = "P2PLink";
    // Data channel messages stay well under the browsers' limit (256 KB);
    // byte 0 of each is 1 on a packet's last fragment
    private static final int FRAGMENT_BYTES = 60_000;

    interface Listener {
        void sendSignal(JSONObject data);

        /** The channel opened (true) or closed (false); called on the session thread. */
        void onOpenChanged(boolean open);
    }

    private static PeerConnectionFactory factory;

    private final Handler thread;
    private final Listener listener;
    private PeerConnection pc;
    private volatile DataChannel channel;
    private volatile boolean open;
    private final List<IceCandidate> pendingCandidates = new ArrayList<>();
    private boolean closed;

    P2PLink(Context context, Handler thread, JSONArray iceServers, Listener listener) {
        this.thread = thread;
        this.listener = listener;
        synchronized (P2PLink.class) {
            if (factory == null) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                        .builder(context.getApplicationContext()).createInitializationOptions());
                factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
            }
        }
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(parseIceServers(iceServers));
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        pc = factory.createPeerConnection(config, new PcObserver());
    }

    void start() {
        if (pc == null) return;
        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true; // H.264 frames must arrive in order and complete
        channel = pc.createDataChannel("video", init);
        channel.registerObserver(new DataChannel.Observer() {
            @Override public void onBufferedAmountChange(long previous) {}
            @Override public void onMessage(DataChannel.Buffer buffer) {}

            @Override
            public void onStateChange() {
                DataChannel ch = channel;
                boolean nowOpen = ch != null && ch.state() == DataChannel.State.OPEN;
                thread.post(() -> setOpen(nowOpen));
            }
        });
        pc.createOffer(new Sdp("create offer") {
            @Override
            public void onCreateSuccess(SessionDescription offer) {
                thread.post(() -> {
                    if (closed) return;
                    pc.setLocalDescription(new Sdp("set offer"), offer);
                    listener.sendSignal(description(offer));
                });
            }
        }, new MediaConstraints());
    }

    boolean isOpen() {
        return open;
    }

    /** Bytes queued in the channel, for the session's backlog check. */
    long buffered() {
        DataChannel ch = channel;
        return ch == null ? 0 : ch.bufferedAmount();
    }

    /** Sends one packet in fragments; false if the channel isn't open. */
    boolean send(byte[] packet) {
        DataChannel ch = channel;
        if (!open || ch == null) return false;
        for (int at = 0; at < packet.length; at += FRAGMENT_BYTES) {
            int n = Math.min(FRAGMENT_BYTES, packet.length - at);
            ByteBuffer frag = ByteBuffer.allocateDirect(1 + n);
            frag.put((byte) (at + n >= packet.length ? 1 : 0));
            frag.put(packet, at, n);
            frag.flip();
            if (!ch.send(new DataChannel.Buffer(frag, true))) return false;
        }
        return true;
    }

    /** A signal from the viewer: its answer, or an ICE candidate. */
    void onSignal(JSONObject data) {
        if (closed || pc == null) return;
        JSONObject d = data.optJSONObject("description");
        JSONObject c = data.optJSONObject("candidate");
        if (d != null && "answer".equals(d.optString("type"))) {
            SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, d.optString("sdp"));
            pc.setRemoteDescription(new Sdp("set answer") {
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

    void close() {
        if (closed) return;
        closed = true;
        open = false;
        DataChannel ch = channel;
        channel = null;
        if (ch != null) {
            ch.unregisterObserver();
            ch.close();
            ch.dispose();
        }
        if (pc != null) {
            pc.dispose();
            pc = null;
        }
    }

    private void setOpen(boolean nowOpen) {
        if (closed || nowOpen == open) return;
        open = nowOpen;
        Log.i(TAG, nowOpen ? "direct path open" : "direct path closed");
        listener.onOpenChanged(nowOpen);
    }

    private static List<PeerConnection.IceServer> parseIceServers(JSONArray arr) {
        List<PeerConnection.IceServer> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s == null) continue;
            List<String> urls = new ArrayList<>();
            JSONArray u = s.optJSONArray("urls");
            if (u != null) for (int k = 0; k < u.length(); k++) urls.add(u.optString(k));
            else if (s.has("urls")) urls.add(s.optString("urls"));
            if (urls.isEmpty()) continue;
            PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
            if (s.has("username")) b.setUsername(s.optString("username"));
            if (s.has("credential")) b.setPassword(s.optString("credential"));
            out.add(b.createIceServer());
        }
        return out;
    }

    private static JSONObject description(SessionDescription sd) {
        JSONObject d = new JSONObject();
        try {
            d.put("description", new JSONObject().put("type", sd.type.canonicalForm()).put("sdp", sd.description));
        } catch (Exception ignored) {}
        return d;
    }

    private class PcObserver implements PeerConnection.Observer {
        @Override
        public void onIceCandidate(IceCandidate c) {
            JSONObject data = new JSONObject();
            try {
                data.put("candidate", new JSONObject()
                        .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex));
            } catch (Exception ignored) {}
            thread.post(() -> {
                if (!closed) listener.sendSignal(data);
            });
        }

        @Override
        public void onConnectionChange(PeerConnection.PeerConnectionState state) {
            if (state == PeerConnection.PeerConnectionState.FAILED
                    || state == PeerConnection.PeerConnectionState.CLOSED) {
                thread.post(() -> setOpen(false));
            }
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
        @Override public void onIceConnectionReceivingChange(boolean receiving) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] cs) {}
        @Override public void onAddStream(MediaStream s) {}
        @Override public void onRemoveStream(MediaStream s) {}
        @Override public void onDataChannel(DataChannel dc) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver r, MediaStream[] ss) {}
    }

    private static class Sdp implements SdpObserver {
        private final String what;

        Sdp(String what) {
            this.what = what;
        }

        @Override public void onCreateSuccess(SessionDescription sd) {}
        @Override public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String error) {
            Log.w(TAG, what + " failed: " + error);
        }

        @Override
        public void onSetFailure(String error) {
            Log.w(TAG, what + " failed: " + error);
        }
    }
}
