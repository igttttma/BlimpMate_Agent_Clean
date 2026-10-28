package com.l2dfacecontrol.host;

import android.app.Activity;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.util.concurrent.Executor;

/**
 * Keeps the AI's replies and greetings at full volume around the microphone.
 *
 * While the WebView's mic is open (echo cancellation on), Chromium puts the device
 * in MODE_IN_COMMUNICATION and plays a voice-call track. Android's audio policy caps
 * every other stream at the call volume + 0.5 dB while in a call or while a
 * voice-call track is active, so replies came out quieter than the greeting
 * (0 dB -> -7.3 dB on the Blimp). The app starts with the media and call volumes at
 * their maximum, and call mode raises the call volume again in case it was lowered.
 *
 * Both are the "Maximum volume" setting (on by default; the Blimp/Orange Pi needs it).
 * Off, the app leaves the device's volumes alone (phones used for testing). Exposed
 * to the page as __nativeVolumeRaw.
 */
public final class CallModeVolume {
    private static final String TAG = "CallModeVolume";
    // Pre-Android 12 has no mode listener
    private static final long POLL_MS = 300;
    private static final String PREFS = "volume";
    private static final String KEY_MAX = "max_volume";

    private final Activity activity;
    private final AudioManager audio;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SharedPreferences prefs;
    private volatile boolean maxVolume;
    private AudioManager.OnModeChangedListener modeListener;
    private boolean inCallMode;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            onMode(audio.getMode());
            handler.postDelayed(this, POLL_MS);
        }
    };

    CallModeVolume(Activity activity) {
        this.activity = activity;
        this.audio = (AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
        this.prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
        this.maxVolume = prefs.getBoolean(KEY_MAX, true);
    }

    @JavascriptInterface
    public boolean getMaxVolume() {
        return maxVolume;
    }

    /** Turning it on applies it now; turning it off leaves the volumes where they are. */
    @JavascriptInterface
    public void setMaxVolume(boolean on) {
        prefs.edit().putBoolean(KEY_MAX, on).apply();
        handler.post(() -> {
            if (maxVolume == on) return;
            maxVolume = on;
            Log.i(TAG, "maximum volume " + (on ? "on" : "off"));
            if (on && audio != null) {
                toMax(AudioManager.STREAM_MUSIC);
                toMax(AudioManager.STREAM_VOICE_CALL);
            }
        });
    }

    void start() {
        if (audio == null) return;
        if (maxVolume) {
            toMax(AudioManager.STREAM_MUSIC);
            toMax(AudioManager.STREAM_VOICE_CALL);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Executor main = handler::post;
            modeListener = this::onMode;
            audio.addOnModeChangedListener(main, modeListener);
            onMode(audio.getMode());
        } else {
            handler.post(poll);
        }
    }

    void stop() {
        handler.removeCallbacksAndMessages(null);
        if (modeListener != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.removeOnModeChangedListener(modeListener);
            modeListener = null;
        }
    }

    private void onMode(int mode) {
        // Only the WebView's VoIP mode: a real phone call keeps the user's call volume
        boolean callMode = mode == AudioManager.MODE_IN_COMMUNICATION;
        if (callMode == inCallMode) return;
        inCallMode = callMode;
        if (callMode && maxVolume) toMax(AudioManager.STREAM_VOICE_CALL);
        // In call mode the volume keys would change the call volume; keep them on media
        activity.setVolumeControlStream(callMode ? AudioManager.STREAM_MUSIC : AudioManager.USE_DEFAULT_STREAM_TYPE);
    }

    private void toMax(int stream) {
        try {
            int max = audio.getStreamMaxVolume(stream);
            int current = audio.getStreamVolume(stream);
            if (current != max) audio.setStreamVolume(stream, max, 0);
            Log.i(TAG, "stream " + stream + " volume " + current + " -> " + max + "/" + max);
        } catch (RuntimeException e) {
            Log.w(TAG, "volume change failed for stream " + stream, e);
        }
    }
}
