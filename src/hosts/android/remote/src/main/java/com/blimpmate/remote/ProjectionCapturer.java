package com.blimpmate.remote;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.SystemClock;
import android.view.Surface;

import org.webrtc.CapturerObserver;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.ThreadUtils;
import org.webrtc.TimestampAligner;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;

/**
 * Feeds the screen into WebRTC through a virtual display. Like WebRTC's
 * ScreenCapturerAndroid, but the MediaProjection is owned by the caller, and a
 * still screen is re-sent twice a second. Android only produces frames when
 * the screen changes, so without this a viewer joining a still screen (frames
 * sent before the connection is up are dropped) would wait for a change.
 */
final class ProjectionCapturer implements VideoCapturer, VideoSink {
    private static final long REPEAT_MS = 500;

    private final MediaProjection projection;
    private final int densityDpi;
    private SurfaceTextureHelper helper;
    private CapturerObserver observer;
    private VirtualDisplay display;
    private int width, height;
    private VideoFrame.I420Buffer lastCopy;
    private int lastRotation;
    private long lastFrameMs;
    // Set once the screen went still: the next frame is kept as a CPU copy
    private boolean wantCopy;
    private boolean running;

    ProjectionCapturer(MediaProjection projection, int densityDpi) {
        this.projection = projection;
        this.densityDpi = densityDpi;
    }

    @Override
    public void initialize(SurfaceTextureHelper helper, Context context, CapturerObserver observer) {
        this.helper = helper;
        this.observer = observer;
    }

    @Override
    public void startCapture(int width, int height, int fps) {
        this.width = width;
        this.height = height;
        helper.setTextureSize(width, height);
        display = createDisplay();
        running = true;
        observer.onCapturerStarted(true);
        helper.startListening(this);
        handler().postDelayed(this::repeatIfStill, REPEAT_MS);
    }

    private VirtualDisplay createDisplay() {
        return projection.createVirtualDisplay("blimpmate-remote", width, height, densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                new Surface(helper.getSurfaceTexture()), null, null);
    }

    @Override
    public void stopCapture() {
        ThreadUtils.invokeAtFrontUninterruptibly(handler(), () -> {
            running = false;
            helper.stopListening();
            if (display != null) {
                display.release();
                display = null;
            }
            releaseCopy();
            observer.onCapturerStopped();
        });
    }

    @Override
    public void changeCaptureFormat(int width, int height, int fps) {
        ThreadUtils.invokeAtFrontUninterruptibly(handler(), () -> {
            if (!running || (width == this.width && height == this.height)) return;
            this.width = width;
            this.height = height;
            releaseCopy();
            helper.setTextureSize(width, height);
            if (display != null) display.release();
            display = createDisplay();
        });
    }

    @Override
    public void dispose() {}

    @Override
    public boolean isScreencast() {
        return true;
    }

    // On the helper's thread
    @Override
    public void onFrame(VideoFrame frame) {
        lastFrameMs = SystemClock.elapsedRealtime();
        observer.onFrameCaptured(frame);
        // The copy must always be the latest frame. A texture frame can't be
        // held (the helper waits for its release before delivering the next).
        releaseCopy();
        // Copying (GPU readback + conversion) is slow on weak devices: only the
        // one frame asked for once the screen is still, never while it changes
        if (wantCopy) {
            wantCopy = false;
            lastCopy = frame.getBuffer().toI420();
            lastRotation = frame.getRotation();
        }
    }

    private void repeatIfStill() {
        if (!running) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastFrameMs >= REPEAT_MS) {
            if (lastCopy != null) {
                lastCopy.retain();
                // WebRTC's clock (the screen's frames use it too); a frame with an
                // older timestamp than the last one is dropped by the encoder
                VideoFrame frame = new VideoFrame(lastCopy, lastRotation, TimestampAligner.getRtcTimeNanos());
                observer.onFrameCaptured(frame);
                frame.release();
                lastFrameMs = now;
            } else if (display != null && !wantCopy) {
                // Still and nothing kept yet: a new virtual display draws the
                // screen once more, and that frame is kept
                wantCopy = true;
                display.release();
                display = createDisplay();
            }
        }
        handler().postDelayed(this::repeatIfStill, REPEAT_MS);
    }

    private void releaseCopy() {
        if (lastCopy != null) {
            lastCopy.release();
            lastCopy = null;
        }
    }

    private Handler handler() {
        return helper.getHandler();
    }
}
