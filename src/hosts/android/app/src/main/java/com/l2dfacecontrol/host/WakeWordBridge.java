package com.l2dfacecontrol.host;

import android.Manifest;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Device-local wake-word detection (openWakeWord models) exposed to the shared WebView. */
public final class WakeWordBridge {
    private static final String TAG = "BlimpMateWake";
    private static final int SAMPLE_RATE = 16000;
    private static final String WAKE_PHRASE = "Hey Blimp";
    private static final String MODE = "openwakeword";
    // Keyword sets the detector can listen for: "wake" (Hey Blimp) or "answer"
    // (incoming calls), each a trained model in assets/wake-models/ with its
    // threshold in wakewords.json
    private volatile String keywordSet = "wake";

    private final Activity activity;
    private final WebView webView;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean workerActive = new AtomicBoolean(false);

    private volatile boolean requested;
    private volatile boolean running;
    private volatile boolean released;
    private volatile String lastError = "";
    private volatile AudioRecord audioRecord;
    // Mic diagnostics, mirroring the desktop service's /wake_word/status fields.
    private volatile long audioSamples;
    private volatile float lastAudioRms;
    private volatile float peakAudioRms;
    // The highest score in about the last second, for tuning thresholds
    private volatile float recentPeakScore;
    // Debug builds only: the last DEBUG_SECONDS of mic audio, for dumpDebugAudio().
    private static final int DEBUG_SECONDS = 10;
    private short[] debugRing;
    private int debugPos;
    private boolean debugWrapped;
    private OpenWakeWord detector;
    private JSONObject thresholds;

    public WakeWordBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public String start() {
        return startKeywords("wake");
    }

    /** Listen for a keyword set: "wake" (Hey Blimp) or "answer" (incoming calls). */
    @JavascriptInterface
    public String startKeywords(String set) {
        keywordSet = "answer".equals(set) ? "answer" : "wake";
        if (released) return status(false, "released");
        requested = true;
        if (!hasAudioPermission()) {
            return status(false, "microphone_permission_required");
        }
        scheduleWorker();
        return status(true, workerActive.get() ? "starting" : "scheduled");
    }

    @JavascriptInterface
    public String stop() {
        requested = false;
        stopRecorder();
        return status(false, "stopping");
    }

    /**
     * Debug builds only: writes the last few seconds the detector heard to
     * files/wake_debug.wav. Pull it with
     * `adb exec-out run-as com.l2dfacecontrol.host cat files/wake_debug.wav > wake.wav`.
     */
    @JavascriptInterface
    public synchronized String dumpDebugAudio() {
        if (!isDebuggable() || debugRing == null) return "{\"ok\":false}";
        int count = debugWrapped ? debugRing.length : debugPos;
        File out = new File(activity.getFilesDir(), "wake_debug.wav");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + count * 2)
                    .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
                    .putShort((short) 1).putShort((short) 1).putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2)
                    .putShort((short) 2).putShort((short) 16)
                    .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(count * 2);
            fos.write(header.array());
            ByteBuffer body = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN);
            int start = debugWrapped ? debugPos : 0;
            for (int i = 0; i < count; i++) body.putShort(debugRing[(start + i) % debugRing.length]);
            fos.write(body.array());
            return "{\"ok\":true,\"path\":\"" + out.getAbsolutePath() + "\",\"samples\":" + count + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    private boolean isDebuggable() {
        return (activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private synchronized void recordDebugAudio(short[] pcm, int count) {
        if (debugRing == null) debugRing = new short[SAMPLE_RATE * DEBUG_SECONDS];
        for (int i = 0; i < count; i++) {
            debugRing[debugPos++] = pcm[i];
            if (debugPos == debugRing.length) { debugPos = 0; debugWrapped = true; }
        }
    }

    @JavascriptInterface
    public String getStatus() {
        return status(running, lastError.isEmpty() ? (running ? "listening" : "stopped") : lastError);
    }

    public void onAudioPermissionResult(boolean granted) {
        if (granted && requested) scheduleWorker();
        if (!granted) {
            requested = false;
            lastError = "microphone_permission_denied";
            postStatus(false, lastError);
        }
    }

    public void release() {
        released = true;
        requested = false;
        stopRecorder();
        executor.shutdownNow();
        synchronized (this) {
            if (detector != null) {
                detector.close();
                detector = null;
            }
        }
    }

    private boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void scheduleWorker() {
        if (!requested || released || !workerActive.compareAndSet(false, true)) return;
        executor.execute(() -> {
            try {
                runDetector();
            } finally {
                running = false;
                workerActive.set(false);
                postStatus(false, lastError.isEmpty() ? "stopped" : lastError);
                // A start() that arrived while this worker was winding down
                if (requested && !released && lastError.isEmpty()) scheduleWorker();
            }
        });
    }

    private synchronized OpenWakeWord getDetector() throws Exception {
        if (detector == null) {
            thresholds = new JSONObject(readAsset("wake-models/wakewords.json"));
            detector = new OpenWakeWord(activity.getAssets(), "hey_blimp", "answer");
        }
        return detector;
    }

    private static String modelFor(String set) {
        return "answer".equals(set) ? "answer" : "hey_blimp";
    }

    private String readAsset(String path) throws Exception {
        try (InputStream in = activity.getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private void runDetector() {
        AudioRecord recorder = null;
        try {
            lastError = "";
            OpenWakeWord oww = getDetector();
            oww.reset();
            String streamSet = keywordSet;

            int minBytes = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
            );
            if (minBytes <= 0) throw new IllegalStateException("invalid AudioRecord buffer size: " + minBytes);
            recorder = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(minBytes * 2, SAMPLE_RATE / 5 * 2)
            );
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("AudioRecord initialization failed");
            }
            audioRecord = recorder;
            audioSamples = 0;
            lastAudioRms = 0f;
            peakAudioRms = 0f;
            recorder.startRecording();
            running = true;
            postStatus(true, "listening");

            short[] pcm = new short[OpenWakeWord.CHUNK];
            final boolean debuggable = isDebuggable();
            final float[] best = {0f};
            // Consecutive 80 ms frames at or above the threshold; a word fires after `patience` of them
            final int[] streak = {0};
            int chunks = 0;
            while (requested && !released) {
                int count = recorder.read(pcm, 0, pcm.length);
                if (count <= 0) continue;
                if (debuggable) recordDebugAudio(pcm, count);
                double sumSquares = 0;
                for (int i = 0; i < count; i++) {
                    float v = pcm[i] / 32768.0f;
                    sumSquares += v * v;
                }
                lastAudioRms = (float) Math.sqrt(sumSquares / count);
                peakAudioRms = Math.max(peakAudioRms, lastAudioRms);
                audioSamples += count;
                if (!streamSet.equals(keywordSet)) {
                    // Switched keyword sets while running: start from fresh audio
                    streamSet = keywordSet;
                    oww.reset();
                    streak[0] = 0;
                }
                String word = modelFor(streamSet);
                JSONObject tuning = thresholds.getJSONObject(word);
                final float threshold = (float) tuning.getDouble("threshold");
                final int patience = tuning.optInt("patience", 1);
                best[0] = 0f;
                oww.accept(pcm, count, word, (score) -> {
                    best[0] = Math.max(best[0], score);
                    streak[0] = score >= threshold ? streak[0] + 1 : 0;
                });
                if (chunks++ % 12 == 0) recentPeakScore = 0f;
                recentPeakScore = Math.max(recentPeakScore, best[0]);
                if (streak[0] >= patience) {
                    Log.i(TAG, "Detected " + word + " (score " + best[0] + ", threshold " + threshold
                            + ", " + streak[0] + " frames)");
                    streak[0] = 0;
                    oww.reset();
                    requested = false;
                    postWake("answer".equals(streamSet) ? "answer" : WAKE_PHRASE, streamSet);
                    break;
                }
            }
        } catch (Throwable error) {
            lastError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            Log.e(TAG, "Wake-word detector failed", error);
        } finally {
            audioRecord = null;
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                recorder.release();
            }
        }
    }

    private void stopRecorder() {
        AudioRecord recorder = audioRecord;
        if (recorder != null) {
            try { recorder.stop(); } catch (Exception ignored) {}
        }
    }

    private String status(boolean isRunning, String message) {
        JSONObject json = new JSONObject();
        try {
            json.put("running", isRunning);
            json.put("mode", MODE);
            json.put("audio_backend", "android-audiorecord");
            json.put("message", message == null ? "" : message);
            json.put("audio_samples", audioSamples);
            json.put("last_audio_rms", lastAudioRms);
            json.put("peak_audio_rms", peakAudioRms);
            json.put("recent_peak_score", recentPeakScore);
        } catch (Exception ignored) {}
        return json.toString();
    }

    private void postStatus(boolean isRunning, String message) {
        postEvent("status", status(isRunning, message));
    }

    private void postWake(String word, String set) {
        JSONObject json = new JSONObject();
        try {
            json.put("type", "wake");
            json.put("word", word);
            json.put("keywords", set);
            json.put("source", MODE);
            json.put("timestamp", System.currentTimeMillis() / 1000.0);
        } catch (Exception ignored) {}
        postEvent("wake", json.toString());
    }

    private void postEvent(String type, String payloadJson) {
        String encoded = Base64.encodeToString(
                payloadJson.getBytes(StandardCharsets.UTF_8),
                Base64.NO_WRAP
        );
        String js = "window.__nativeWakeWordDispatch && window.__nativeWakeWordDispatch(\""
                + type + "\", \"" + encoded + "\")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
