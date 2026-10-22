package com.l2dfacecontrol.host;

import android.content.res.AssetManager;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * openWakeWord streaming detection (port of openwakeword.utils.AudioFeatures):
 * every 80 ms of 16 kHz audio gives 8 mel frames, the last 76 frames give one
 * speech embedding, and a word's classifier scores the last 16 embeddings
 * (about 2 s). Models live in assets/wake-models/ (see src/wake-models/README.md).
 */
final class OpenWakeWord implements AutoCloseable {
    static final int CHUNK = 1280; // 80 ms
    private static final int MEL_CONTEXT = 480; // 3 extra hops so a chunk yields 8 frames
    private static final int MEL_BINS = 32;
    private static final int MEL_WINDOW = 76;
    private static final int EMBEDDING = 96;
    private static final int FEATURE_WINDOW = 16;
    private static final String DIR = "wake-models/";

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private final OrtSession melspec;
    private final OrtSession embedding;
    private final Map<String, OrtSession> classifiers = new HashMap<>();

    private final float[] raw = new float[CHUNK + MEL_CONTEXT];
    private int pending; // samples of the current chunk received so far
    private final float[][] mel = new float[MEL_WINDOW][MEL_BINS];
    private final float[][] features = new float[FEATURE_WINDOW][EMBEDDING];
    private int realFeatures; // embeddings computed since the last reset (scores need 16)

    OpenWakeWord(AssetManager assets, String... words) throws IOException, OrtException {
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setIntraOpNumThreads(1);
        melspec = env.createSession(read(assets, DIR + "melspectrogram.onnx"), options);
        embedding = env.createSession(read(assets, DIR + "embedding_model.onnx"), options);
        for (String word : words) {
            classifiers.put(word, env.createSession(read(assets, DIR + word + ".onnx"), options));
        }
        reset();
    }

    /** Forget all audio heard so far (after a detection or a keyword switch). */
    void reset() {
        java.util.Arrays.fill(raw, 0f);
        pending = 0;
        for (float[] row : mel) java.util.Arrays.fill(row, 1f);
        realFeatures = 0;
    }

    /**
     * Feeds 16-bit samples; calls onScore once per completed 80 ms chunk with
     * the word's score in [0, 1] (0 until 2 s of audio has been heard).
     */
    void accept(short[] pcm, int count, String word, ScoreListener onScore) throws OrtException {
        for (int i = 0; i < count; i++) {
            raw[MEL_CONTEXT + pending++] = pcm[i]; // the models take int16-range floats
            if (pending == CHUNK) {
                step();
                onScore.onScore(realFeatures >= FEATURE_WINDOW ? score(word) : 0f);
                // Keep the last 480 samples as context for the next chunk's frames
                System.arraycopy(raw, CHUNK, raw, 0, MEL_CONTEXT);
                pending = 0;
            }
        }
    }

    interface ScoreListener {
        void onScore(float score) throws OrtException;
    }

    private void step() throws OrtException {
        // Mel frames for this chunk, scaled like openWakeWord (x / 10 + 2)
        float[][] frames;
        try (OnnxTensor in = OnnxTensor.createTensor(env, FloatBuffer.wrap(raw), new long[]{1, raw.length});
             OrtSession.Result out = melspec.run(Collections.singletonMap(melspec.getInputNames().iterator().next(), in))) {
            frames = ((float[][][][]) out.get(0).getValue())[0][0];
        }
        int n = frames.length;
        System.arraycopy(mel, n, mel, 0, MEL_WINDOW - n);
        for (int f = 0; f < n; f++) {
            float[] row = new float[MEL_BINS];
            for (int b = 0; b < MEL_BINS; b++) row[b] = frames[f][b] / 10f + 2f;
            mel[MEL_WINDOW - n + f] = row;
        }

        FloatBuffer melInput = FloatBuffer.allocate(MEL_WINDOW * MEL_BINS);
        for (float[] row : mel) melInput.put(row);
        melInput.rewind();
        float[] vector;
        try (OnnxTensor in = OnnxTensor.createTensor(env, melInput, new long[]{1, MEL_WINDOW, MEL_BINS, 1});
             OrtSession.Result out = embedding.run(Collections.singletonMap(embedding.getInputNames().iterator().next(), in))) {
            vector = ((float[][][][]) out.get(0).getValue())[0][0][0];
        }
        System.arraycopy(features, 1, features, 0, FEATURE_WINDOW - 1);
        features[FEATURE_WINDOW - 1] = vector;
        if (realFeatures < FEATURE_WINDOW) realFeatures++;
    }

    private float score(String word) throws OrtException {
        OrtSession classifier = classifiers.get(word);
        if (classifier == null) return 0f;
        FloatBuffer input = FloatBuffer.allocate(FEATURE_WINDOW * EMBEDDING);
        for (float[] row : features) input.put(row);
        input.rewind();
        try (OnnxTensor in = OnnxTensor.createTensor(env, input, new long[]{1, FEATURE_WINDOW, EMBEDDING});
             OrtSession.Result out = classifier.run(Collections.singletonMap(classifier.getInputNames().iterator().next(), in))) {
            return ((float[][]) out.get(0).getValue())[0][0];
        }
    }

    private static byte[] read(AssetManager assets, String path) throws IOException {
        try (InputStream in = assets.open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    @Override
    public void close() {
        for (OrtSession s : classifiers.values()) {
            try { s.close(); } catch (Exception ignored) {}
        }
        try { melspec.close(); } catch (Exception ignored) {}
        try { embedding.close(); } catch (Exception ignored) {}
    }
}
