package com.l2dfacecontrol.host;

import android.Manifest;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.SystemClock;
import android.os.Looper;
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
    // A failed detector (mic busy or lost, audio server restart) retries while
    // the wake word is wanted, backing off from RETRY_MIN_MS to RETRY_MAX_MS
    private static final long RETRY_MIN_MS = 1000;
    private static final long RETRY_MAX_MS = 30000;
    private final Handler retryHandler = new Handler(Looper.getMainLooper());
    private volatile long retryDelayMs = RETRY_MIN_MS;

    private volatile boolean requested;
    private volatile boolean running;
    // Conversation audio: the page asked for the mic stream (startStream). The
    // recorder the wake word already has open is handed over, so the mic is
    // ready the moment the greeting ends (opening the WebView mic took ~1.3 s on
    // the Blimp and lost the user's first words).
    private volatile boolean streaming;
    // Keep the recorder open until this time (uptime ms) even when nobody wants
    // it: after "Hey Blimp" (the page starts the stream after the greeting) and
    // between the turns of a conversation
    private volatile long holdUntil;
    private static final long HOLD_MS = 15000;
    // Near-miss reporting (wake word tuning): bursts reaching this score
    private static final float NEAR_MIN = 0.15f;
    private volatile float lastWakeScore;
    private volatile float lastWakeRms;
    // Wake word samples (portal "Record"): the next N seconds of the recorder,
    // scored with the chosen keyword's model; it can't fire while recording
    private volatile boolean sampling;
    private short[] sampleBuf;
    private int samplePos;
    private String sampleId = "";
    private String sampleSet = "wake";
    private float sampleScore;
    private float sampleRms;
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
        retryHandler.removeCallbacksAndMessages(null);
        retryDelayMs = RETRY_MIN_MS;
        if (!hasAudioPermission()) {
            return status(false, "microphone_permission_required");
        }
        scheduleWorker();
        return status(true, workerActive.get() ? "starting" : "scheduled");
    }

    @JavascriptInterface
    public String stop() {
        requested = false;
        retryHandler.removeCallbacksAndMessages(null);
        if (!keepOpen()) stopRecorder();
        return status(false, "stopping");
    }

    /** Conversation audio: post the mic as "pcm" events (16 kHz mono s16le, 80 ms chunks). */
    @JavascriptInterface
    public String startStream() {
        if (released) return status(false, "released");
        if (!hasAudioPermission()) return status(false, "microphone_permission_required");
        streaming = true;
        holdUntil = 0;
        retryHandler.removeCallbacksAndMessages(null);
        scheduleWorker();
        return status(true, "streaming");
    }

    /** End of a listening turn; the recorder stays warm for the next one (HOLD_MS). */
    @JavascriptInterface
    public String stopStream() {
        streaming = false;
        holdUntil = SystemClock.uptimeMillis() + HOLD_MS;
        return status(running, "stream_stopped");
    }

    /** Give the mic up now (a video call is about to open it), unless the wake word still listens. */
    @JavascriptInterface
    public String releaseMic() {
        streaming = false;
        holdUntil = 0;
        if (!requested) stopRecorder();
        return status(running, "released_mic");
    }

    /**
     * Records the next `seconds` (0.5-10) for the portal's wake word samples; the
     * result comes as a "sample" event: { id, wav (base64), score, level_dbfs }.
     * `set` picks the model that scores it ("wake" or "answer").
     */
    @JavascriptInterface
    public String recordSample(double seconds, String id, String set) {
        if (released) return status(false, "released");
        if (!hasAudioPermission()) return status(false, "microphone_permission_required");
        if (sampling) return status(running, "sampling_busy");
        double secs = Math.max(0.5, Math.min(10.0, seconds));
        synchronized (this) {
            sampleBuf = new short[(int) (secs * SAMPLE_RATE)];
            samplePos = 0;
            sampleId = id == null ? "" : id;
            sampleSet = "answer".equals(set) ? "answer" : "wake";
            sampleScore = 0f;
            sampleRms = 0f;
            sampling = true;
        }
        holdUntil = Math.max(holdUntil, SystemClock.uptimeMillis() + (long) (secs * 1000) + 2000);
        retryHandler.removeCallbacksAndMessages(null);
        scheduleWorker();
        return status(true, "sampling");
    }

    private boolean keepOpen() {
        return streaming || sampling || SystemClock.uptimeMillis() < holdUntil;
    }

    /** Copies a chunk into the sample; posts it once full. */
    private void takeSample(short[] pcm, int count, float rms) {
        String done = null;
        synchronized (this) {
            if (!sampling || sampleBuf == null) return;
            int n = Math.min(count, sampleBuf.length - samplePos);
            System.arraycopy(pcm, 0, sampleBuf, samplePos, n);
            samplePos += n;
            sampleRms = Math.max(sampleRms, rms);
            if (samplePos < sampleBuf.length) return;
            sampling = false;
            JSONObject json = new JSONObject();
            try {
                json.put("type", "sample");
                json.put("id", sampleId);
                json.put("keywords", sampleSet);
                json.put("score", Math.round(sampleScore * 1000) / 1000.0);
                json.put("level_dbfs", Math.round(dbfs(sampleRms)));
                json.put("wav", Base64.encodeToString(wavBytes(sampleBuf), Base64.NO_WRAP));
            } catch (Exception ignored) {}
            done = json.toString();
            sampleBuf = null;
        }
        Log.i(TAG, "Sample recorded (" + sampleSet + ")");
        postEvent("sample", done);
    }

    private static byte[] wavBytes(short[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(44 + pcm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
                .putShort((short) 1).putShort((short) 1).putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2)
                .putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length * 2);
        for (short v : pcm) b.putShort(v);
        return b.array();
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
        // "stopped" only when nobody wants it: a worker starting up or a retry
        // waiting says so
        String state = running ? "listening" : requested ? "starting" : "stopped";
        return status(running, lastError.isEmpty() ? state : lastError);
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
        retryHandler.removeCallbacksAndMessages(null);
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
        if ((!requested && !streaming && !sampling) || released || !workerActive.compareAndSet(false, true)) return;
        executor.execute(() -> {
            try {
                runDetector();
            } finally {
                running = false;
                workerActive.set(false);
                postStatus(false, lastError.isEmpty() ? "stopped" : lastError);
                // A start() that arrived while this worker was winding down
                boolean wanted = (requested || streaming || sampling) && !released;
                if (wanted && lastError.isEmpty()) scheduleWorker();
                else if (wanted) scheduleRetry();
            }
        });
    }

    private void scheduleRetry() {
        long delay = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
        Log.w(TAG, "Wake-word detector stopped (" + lastError + "); retrying in " + delay + " ms");
        retryHandler.postDelayed(this::scheduleWorker, delay);
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
            // No platform echo canceller: on the Blimp, switching it on for conversations
            // left the stream near-silent from the second conversation on (2026-11-03),
            // while the wake word on the same recorder heard fine. The Blimp's mic
            // hardware cancels the echo itself.
            audioSamples = 0;
            lastAudioRms = 0f;
            peakAudioRms = 0f;
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IllegalStateException("AudioRecord did not start (microphone busy?)");
            }
            running = true;
            postStatus(true, "listening");

            short[] pcm = new short[OpenWakeWord.CHUNK];
            final boolean debuggable = isDebuggable();
            final float[] best = {0f};
            // Consecutive 80 ms frames at or above the threshold; a word fires after `patience` of them
            final int[] streak = {0};
            int chunks = 0;
            boolean detecting = false;
            // Near misses (tuning diagnostics): a burst of score >= NEAR_MIN that
            // didn't fire, reported once it has died down
            float burstPeak = 0f;
            int burstRun = 0;
            float burstRms = 0f;
            // Loudest 80 ms chunk of the last ~1.5 s: the word itself (scores peak after it ends)
            final float[] recentRms = new float[19];
            int rmsAt = 0;
            int quietChunks = 0;
            while (!released && (requested || keepOpen())) {
                int count = recorder.read(pcm, 0, pcm.length);
                // stop() makes a blocked read return early; anything else negative
                // is a dead recorder (e.g. ERROR_DEAD_OBJECT): fail and retry
                if (count < 0 && (requested || streaming) && !released) {
                    throw new IllegalStateException("AudioRecord read failed: " + count);
                }
                if (count <= 0) {
                    if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                        // Stopped under us (released, then wanted again): reopen cleanly; the
                        // worker's finally block restarts it while it is still wanted
                        Log.w(TAG, "Recorder stopped while still wanted; reopening");
                        break;
                    }
                    continue;
                }
                retryDelayMs = RETRY_MIN_MS;
                if (debuggable) recordDebugAudio(pcm, count);
                double sumSquares = 0;
                for (int i = 0; i < count; i++) {
                    float v = pcm[i] / 32768.0f;
                    sumSquares += v * v;
                }
                lastAudioRms = (float) Math.sqrt(sumSquares / count);
                peakAudioRms = Math.max(peakAudioRms, lastAudioRms);
                audioSamples += count;
                recentRms[rmsAt] = lastAudioRms;
                rmsAt = (rmsAt + 1) % recentRms.length;
                if (streaming) postPcm(pcm, count);
                boolean recording = sampling;
                if (!requested && !recording) {
                    // Only holding the mic (or streaming): no keyword detection
                    detecting = false;
                    continue;
                }
                String wantedSet = recording ? sampleSet : keywordSet;
                if (!detecting) {
                    // (Re)armed while the recorder was already open: fresh state
                    detecting = true;
                    oww.reset();
                    streak[0] = 0;
                    streamSet = wantedSet;
                }
                if (!streamSet.equals(wantedSet)) {
                    // Switched keyword sets while running: start from fresh audio
                    streamSet = wantedSet;
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
                if (recording) {
                    // A sample: score it, never fire or report near misses
                    sampleScore = Math.max(sampleScore, best[0]);
                    takeSample(pcm, count, lastAudioRms);
                    streak[0] = 0;
                    burstPeak = 0f;
                    burstRun = 0;
                    burstRms = 0f;
                    if (!sampling) {
                        // Done: back to the wake word (if armed) from fresh audio
                        detecting = false;
                    }
                    continue;
                }
                if (best[0] >= NEAR_MIN) {
                    burstPeak = Math.max(burstPeak, best[0]);
                    burstRun = Math.max(burstRun, streak[0]);
                    burstRms = Math.max(burstRms, maxOf(recentRms));
                    quietChunks = 0;
                } else if (burstPeak > 0f && ++quietChunks >= 6) {
                    postNear(streamSet, burstPeak, burstRun, burstRms, threshold, patience);
                    burstPeak = 0f;
                    burstRun = 0;
                    burstRms = 0f;
                }
                if (streak[0] >= patience) {
                    Log.i(TAG, "Detected " + word + " (score " + best[0] + ", threshold " + threshold
                            + ", " + streak[0] + " frames)");
                    lastWakeScore = Math.max(burstPeak, best[0]);
                    lastWakeRms = Math.max(burstRms, maxOf(recentRms));
                    burstPeak = 0f;
                    burstRun = 0;
                    burstRms = 0f;
                    streak[0] = 0;
                    oww.reset();
                    requested = false;
                    detecting = false;
                    // "Hey Blimp": keep the mic for the conversation's stream. A call
                    // answer gives it up (WebRTC opens its own).
                    if (!"answer".equals(streamSet)) holdUntil = SystemClock.uptimeMillis() + HOLD_MS;
                    postWake("answer".equals(streamSet) ? "answer" : WAKE_PHRASE, streamSet);
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
            json.put("streaming", streaming);
            json.put("aec", false);
            json.put("recording", audioRecord != null
                    && audioRecord.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING);
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
            json.put("score", Math.round(lastWakeScore * 1000) / 1000.0);
            json.put("level_dbfs", Math.round(dbfs(lastWakeRms)));
            json.put("timestamp", System.currentTimeMillis() / 1000.0);
        } catch (Exception ignored) {}
        postEvent("wake", json.toString());
    }

    private static float peakRmsOf(short[] pcm, int count) {
        double sum = 0;
        for (int i = 0; i < count; i++) {
            float v = pcm[i] / 32768.0f;
            sum += v * v;
        }
        return count > 0 ? (float) Math.sqrt(sum / count) : 0f;
    }

    private static float maxOf(float[] values) {
        float m = 0f;
        for (float v : values) m = Math.max(m, v);
        return m;
    }

    private static double dbfs(float rms) {
        return 20 * Math.log10(Math.max(rms, 1e-5f));
    }

    /** A burst that scored but didn't fire: its best score, longest run and loudness. */
    private void postNear(String set, float peak, int run, float rms, float threshold, int patience) {
        JSONObject json = new JSONObject();
        try {
            json.put("type", "near");
            json.put("keywords", set);
            json.put("score", Math.round(peak * 1000) / 1000.0);
            json.put("frames", run);
            json.put("level_dbfs", Math.round(dbfs(rms)));
            json.put("threshold", threshold);
            json.put("patience", patience);
        } catch (Exception ignored) {}
        Log.i(TAG, "Near miss: " + json);
        postEvent("near", json.toString());
    }

    /** Conversation audio to the page: base64 s16le, decoded by the glue's "pcm" dispatch. */
    private void postPcm(short[] pcm, int count) {
        ByteBuffer buf = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < count; i++) buf.putShort(pcm[i]);
        String js = "window.__nativeWakeWordDispatch && window.__nativeWakeWordDispatch(\"pcm\", \""
                + Base64.encodeToString(buf.array(), Base64.NO_WRAP) + "\")";
        webView.post(() -> webView.evaluateJavascript(js, null));
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
