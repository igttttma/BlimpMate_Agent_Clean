package com.blimpmate.remote;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;

/**
 * Asks Android for screen capture and hands the result to the service. With
 * the PROJECT_MEDIA app-op granted (README.md) Android answers at once without
 * showing its dialog, so this screen is only up for a moment.
 */
public final class ProjectionActivity extends Activity {
    public interface Callback {
        void onResult(int resultCode, Intent data);
    }

    private static final int REQUEST = 1;
    private static volatile Callback pending;

    /** Starts the request; the callback runs once (on the main thread). */
    public static void request(android.content.Context context, Callback callback) {
        pending = callback;
        Intent i = new Intent(context, ProjectionActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        context.startActivity(i);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) {
            MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST) return;
        deliver(resultCode, data);
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        // Closed before Android answered
        if (isFinishing()) deliver(RESULT_CANCELED, null);
        super.onDestroy();
    }

    private static void deliver(int resultCode, Intent data) {
        Callback cb = pending;
        pending = null;
        if (cb != null) cb.onResult(resultCode, data);
    }
}
