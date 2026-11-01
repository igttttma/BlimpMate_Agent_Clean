package com.blimpmate.speaker;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Plays the AI's voice: raw Opus frames (one per websocket message, as the
 * Blimp gets them) through the platform Opus decoder into an AudioTrack.
 * Frames play as they arrive, like on the Blimp; a gap is silence.
 */
final class VoicePlayer {
    private static final String TAG = "BlimpSpeaker";
    private static final int DECODE_RATE = 48000; // the Opus decoder always outputs 48 kHz

    private final LinkedBlockingQueue<byte[]> frames = new LinkedBlockingQueue<>();
    private final AtomicBoolean flushRequested = new AtomicBoolean();
    private volatile boolean running = true;
    private final Thread thread = new Thread(this::run, "voice");
    private MediaCodec codec;
    private AudioTrack track;
    private int trackRate, trackChannels;
    private long pts;

    VoicePlayer() {
        thread.start();
    }

    void feed(byte[] opusFrame) {
        frames.offer(opusFrame);
    }

    /** Drops what is queued and buffered (the reply was interrupted). */
    void flush() {
        frames.clear();
        flushRequested.set(true);
    }

    void release() {
        running = false;
        thread.interrupt();
    }

    private void run() {
        try {
            codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            codec.configure(opusFormat(), null, null, 0);
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (running) {
                if (flushRequested.getAndSet(false)) {
                    codec.flush();
                    if (track != null) {
                        track.pause();
                        track.flush();
                        track.play();
                    }
                }
                byte[] frame = frames.poll(20, TimeUnit.MILLISECONDS);
                if (frame != null) {
                    int in = codec.dequeueInputBuffer(10_000);
                    if (in >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(in);
                        buffer.clear();
                        buffer.put(frame);
                        codec.queueInputBuffer(in, 0, frame.length, pts, 0);
                        pts += 60_000;
                    }
                }
                drain(info);
            }
        } catch (InterruptedException ignored) {
            // released
        } catch (Exception e) {
            Log.e(TAG, "Voice player stopped", e);
            SpeakerService.status = "Voice player error: " + e.getMessage();
        } finally {
            if (codec != null) codec.release();
            if (track != null) track.release();
        }
    }

    private void drain(MediaCodec.BufferInfo info) {
        while (true) {
            int out = codec.dequeueOutputBuffer(info, 0);
            if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat f = codec.getOutputFormat();
                ensureTrack(f.getInteger(MediaFormat.KEY_SAMPLE_RATE), f.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
            } else if (out >= 0) {
                if (info.size > 0) {
                    ensureTrack(trackRate > 0 ? trackRate : DECODE_RATE, trackChannels > 0 ? trackChannels : 1);
                    ByteBuffer pcm = codec.getOutputBuffer(out);
                    pcm.position(info.offset);
                    pcm.limit(info.offset + info.size);
                    track.write(pcm, info.size, AudioTrack.WRITE_BLOCKING);
                }
                codec.releaseOutputBuffer(out, false);
            } else {
                return; // INFO_TRY_AGAIN_LATER
            }
        }
    }

    private void ensureTrack(int rate, int channels) {
        if (track != null && rate == trackRate && channels == trackChannels) return;
        if (track != null) track.release();
        int mask = channels == 2 ? AudioFormat.CHANNEL_OUT_STEREO : AudioFormat.CHANNEL_OUT_MONO;
        int min = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT);
        track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setSampleRate(rate)
                        .setChannelMask(mask)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build())
                .setBufferSizeInBytes(min * 4)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        track.play();
        trackRate = rate;
        trackChannels = channels;
    }

    /** Mono Opus; the codec-specific data is an Ogg-style OpusHead plus pre-skip / pre-roll. */
    private static MediaFormat opusFormat() {
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, DECODE_RATE, 1);
        ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
        head.put("OpusHead".getBytes(StandardCharsets.US_ASCII));
        head.put((byte) 1);          // version
        head.put((byte) 1);          // channels
        head.putShort((short) 0);    // pre-skip
        head.putInt(DECODE_RATE);    // input sample rate (informational)
        head.putShort((short) 0);    // output gain
        head.put((byte) 0);          // channel mapping family
        head.flip();
        format.setByteBuffer("csd-0", head);
        format.setByteBuffer("csd-1", nanos(0));
        format.setByteBuffer("csd-2", nanos(80_000_000L));
        return format;
    }

    private static ByteBuffer nanos(long value) {
        ByteBuffer b = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        b.putLong(value);
        b.flip();
        return b;
    }
}
