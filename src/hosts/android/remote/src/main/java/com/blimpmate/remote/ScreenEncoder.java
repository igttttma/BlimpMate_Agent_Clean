package com.blimpmate.remote;

import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;

import java.nio.ByteBuffer;

/**
 * The screen as an H.264 stream from the device's hardware encoder: the
 * virtual display renders straight into the encoder's input surface (no copy,
 * no GPU readback), and the encoder repeats the last frame by itself when the
 * screen is still.
 *
 * Adapted from scrcpy's SurfaceEncoder (https://github.com/Genymobile/scrcpy,
 * server/src/main/java/com/genymobile/scrcpy/video/SurfaceEncoder.java,
 * v5.0.1, Copyright (C) Genymobile, Apache License 2.0): the encoder format
 * and the encode loop are scrcpy's; the capture is a MediaProjection virtual
 * display instead of scrcpy's shell-only display APIs.
 */
final class ScreenEncoder {
    private static final String TAG = "ScreenEncoder";
    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final int I_FRAME_INTERVAL_S = 10; // scrcpy's DEFAULT_I_FRAME_INTERVAL
    private static final long REPEAT_FRAME_DELAY_US = 100_000; // repeat after 100 ms
    private static final String KEY_MAX_FPS_TO_ENCODER = "max-fps-to-encoder";
    private static final long DEQUEUE_TIMEOUT_US = 100_000;

    interface Sink {
        /** One encoded packet; data is only valid during the call. */
        void onPacket(ByteBuffer data, boolean config, boolean keyFrame, long ptsUs);

        void onError(String error);
    }

    private final MediaProjection projection;
    private final int densityDpi;
    private final Sink sink;

    private VirtualDisplay display;
    private MediaCodec codec;
    private Surface inputSurface;
    private Thread thread;
    private volatile boolean running;

    ScreenEncoder(MediaProjection projection, int densityDpi, Sink sink) {
        this.projection = projection;
        this.densityDpi = densityDpi;
        this.sink = sink;
    }

    /** The hardware encoder's name, e.g. c2.allwinner.avc.encoder. */
    String encoderName() {
        MediaCodec c = codec;
        return c == null ? "" : c.getName();
    }

    /** Starts (or restarts, after a size or quality change) the stream. */
    void start(int width, int height, int maxFps, int bitRate) throws Exception {
        stop();
        codec = MediaCodec.createEncoderByType(MIME);
        codec.configure(createFormat(width, height, maxFps, bitRate), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        inputSurface = codec.createInputSurface();
        // Android 14+ allows one virtual display per projection: it is created
        // once, then resized and pointed at each new encoder
        if (display == null) {
            display = projection.createVirtualDisplay("blimpmate-remote", width, height, densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, inputSurface, null, null);
        } else {
            display.resize(width, height, densityDpi);
            display.setSurface(inputSurface);
        }
        codec.start();
        running = true;
        MediaCodec mine = codec;
        thread = new Thread(() -> encodeLoop(mine), "screen-encoder");
        thread.start();
        Log.i(TAG, "encoding " + width + "x" + height + " up to " + maxFps + " fps, "
                + bitRate / 1000 + " kbps with " + codec.getName());
    }

    /** Asks the encoder for a keyframe now (a viewer joined or fell behind). */
    void requestKeyFrame() {
        MediaCodec c = codec;
        if (c == null) return;
        Bundle params = new Bundle();
        params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            c.setParameters(params);
        } catch (IllegalStateException ignored) {}
    }

    /** Changes the bitrate on the fly (the connection backed up, or cleared). */
    void setBitRate(int bitRate) {
        MediaCodec c = codec;
        if (c == null) return;
        Bundle params = new Bundle();
        params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bitRate);
        try {
            c.setParameters(params);
        } catch (IllegalStateException ignored) {}
    }

    /** Stops encoding; the virtual display is kept for a restart. */
    void stop() {
        running = false;
        if (thread != null) {
            try {
                thread.join(1000);
            } catch (InterruptedException ignored) {}
            thread = null;
        }
        if (display != null) display.setSurface(null);
        if (codec != null) {
            try {
                codec.stop();
            } catch (IllegalStateException ignored) {}
            codec.release();
            codec = null;
        }
        if (inputSurface != null) {
            inputSurface.release();
            inputSurface = null;
        }
    }

    void release() {
        stop();
        if (display != null) {
            display.release();
            display = null;
        }
    }

    // scrcpy's encode(), with a timeout so stop() ends it
    private void encodeLoop(MediaCodec c) {
        // Some devices (Meizu) deadlock if the video encoding thread has no Looper (scrcpy #4143)
        Looper.prepare();
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (running) {
                int id = c.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US);
                if (id < 0) continue;
                try {
                    if (info.size > 0) {
                        ByteBuffer buffer = c.getOutputBuffer(id);
                        if (buffer != null) {
                            buffer.position(info.offset).limit(info.offset + info.size);
                            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                            sink.onPacket(buffer, config, key, info.presentationTimeUs);
                        }
                    }
                } finally {
                    c.releaseOutputBuffer(id, false);
                }
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
        } catch (IllegalStateException e) {
            if (running) sink.onError("Encoder stopped: " + e.getMessage());
        }
    }

    // scrcpy's createFormat()
    private static MediaFormat createFormat(int width, int height, int maxFps, int bitRate) {
        MediaFormat format = MediaFormat.createVideoFormat(MIME, width, height);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        // must be present to configure the encoder, but does not impact the actual frame rate, which is variable
        format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
        // Not every encoder honors it: Allwinner's keeps a keyframe every 30 frames
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_S);
        // display the very first frame, and recover from bad quality when no new frames
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_FRAME_DELAY_US);
        // real-time priority
        format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        // output 1 frame as soon as 1 frame is queued
        format.setInteger(MediaFormat.KEY_LATENCY, 1);
        format.setFloat(KEY_MAX_FPS_TO_ENCODER, maxFps);
        return format;
    }
}
