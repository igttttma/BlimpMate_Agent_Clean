package com.blimpmate.speaker;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * One text box (the xz-server address), Start / Stop, and the connection status.
 * The server can also be set from adb:
 *   adb shell am start -n com.blimpmate.speaker/.SetupActivity --es server 101.201.30.58
 */
public final class SetupActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private EditText server;
    private TextView status;
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            MediaCache cache = SpeakerService.cache;
            status.setText(SpeakerService.status + (cache != null ? "\n" + cache.summary() : ""));
            main.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Play the Blimp's sound on this device");
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Connect this device to the big speaker. It plays the AI's voice, portal audio clips and "
                + "video sound, alongside the Blimp (not synced). Video calls stay on the Blimp.");
        hint.setPadding(0, dp(6), 0, dp(16));
        root.addView(hint);

        server = new EditText(this);
        server.setHint("Server address, e.g. 101.201.30.58");
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setSingleLine(true);
        server.setText(SpeakerService.savedServer(this));
        root.addView(server);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setPadding(0, dp(12), 0, dp(12));
        Button start = new Button(this);
        start.setText("Start");
        start.setOnClickListener(v -> {
            SpeakerService.saveServer(this, server.getText().toString());
            SpeakerService.start(this);
        });
        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(v -> SpeakerService.stop(this));
        buttons.addView(start);
        buttons.addView(stop);
        root.addView(buttons);

        status = new TextView(this);
        status.setTextSize(15);
        root.addView(status);
        setContentView(root);

        String fromAdb = getIntent().getStringExtra("server");
        if (fromAdb != null) {
            server.setText(fromAdb);
            SpeakerService.saveServer(this, fromAdb);
            SpeakerService.start(this);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.post(refresh);
    }

    @Override
    protected void onPause() {
        main.removeCallbacks(refresh);
        super.onPause();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
