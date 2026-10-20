package com.blimpmate.remote;

import android.Manifest;
import android.app.Activity;
import android.app.AppOpsManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Setup and status. The server settings can also be set from adb:
 *   adb shell am start -n com.blimpmate.remote/.SetupActivity --es url wss://host:8443
 * The touch-test pad changes color on every tap, to check remote input.
 */
public final class SetupActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private EditText url;
    private TextView status, checks;
    private Button battery;
    private int taps;
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            render();
            main.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyExtras(getIntent());
        buildUi();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        RemoteService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (applyExtras(intent)) {
            url.setText(Config.load(this).url);
        }
    }

    /** Saves a url passed by adb; true when one was. */
    private boolean applyExtras(Intent intent) {
        String u = intent.getStringExtra("url");
        if (u == null) return false;
        Config.save(this, u);
        RemoteService.reconnect(this);
        return true;
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

    private void buildUi() {
        int pad = dp(16);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);

        Config c = Config.load(this);
        col.addView(label("Stream server (wss://host:8443)"));
        url = new EditText(this);
        url.setSingleLine();
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(c.url);
        col.addView(url);
        Button save = new Button(this);
        save.setText("Save and connect");
        save.setOnClickListener(v -> {
            Config.save(this, url.getText().toString());
            RemoteService.reconnect(this);
        });
        col.addView(save);

        status = new TextView(this);
        status.setTextSize(16);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setPadding(0, pad, 0, pad / 2);
        col.addView(status);

        checks = new TextView(this);
        checks.setTextIsSelectable(true);
        checks.setTypeface(Typeface.MONOSPACE);
        checks.setTextSize(13);
        col.addView(checks);

        battery = new Button(this);
        battery.setText("Allow running in the background");
        battery.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                android.net.Uri.parse("package:" + getPackageName()))));
        col.addView(battery);

        col.addView(label("Touch test (changes color on every tap)"));
        TextView testPad = new TextView(this);
        testPad.setGravity(Gravity.CENTER);
        testPad.setTextColor(Color.WHITE);
        testPad.setTextSize(18);
        testPad.setText("Taps: 0");
        testPad.setBackgroundColor(Color.rgb(40, 60, 160));
        testPad.setMinHeight(dp(160));
        testPad.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_DOWN) {
                taps++;
                testPad.setText("Taps: " + taps);
                testPad.setBackgroundColor(taps % 2 == 0 ? Color.rgb(40, 60, 160) : Color.rgb(200, 60, 40));
            }
            return true;
        });
        col.addView(testPad);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
    }

    private void render() {
        status.setText(RemoteService.status);
        String pkg = getPackageName();
        StringBuilder s = new StringBuilder();
        boolean input = InputService.get() != null;
        boolean capture = projectMediaAllowed();
        boolean overlay = Settings.canDrawOverlays(this);
        boolean batteryOk = getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(pkg);
        battery.setVisibility(batteryOk ? View.GONE : View.VISIBLE);
        boolean notify = Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        s.append(line(input, "Input control (accessibility service)"));
        if (!input) {
            s.append("    adb shell settings put secure enabled_accessibility_services ")
                    .append(pkg).append("/.InputService\n")
                    .append("    adb shell settings put secure accessibility_enabled 1\n");
        }
        s.append(line(capture, "Screen capture without asking"));
        if (!capture) s.append("    adb shell appops set ").append(pkg).append(" PROJECT_MEDIA allow\n");
        s.append(line(overlay, "Start from the background (display over other apps)"));
        if (!overlay) s.append("    adb shell appops set ").append(pkg).append(" SYSTEM_ALERT_WINDOW allow\n");
        s.append(line(batteryOk, "Not stopped by battery saving"));
        if (!batteryOk) s.append("    adb shell dumpsys deviceidle whitelist +").append(pkg).append('\n');
        s.append(line(notify, "Status notification"));
        if (!notify) s.append("    adb shell pm grant ").append(pkg).append(" android.permission.POST_NOTIFICATIONS\n");
        checks.setText(s.toString());
    }

    /** Whether the PROJECT_MEDIA app-op is allowed (Android then skips its capture dialog). */
    private boolean projectMediaAllowed() {
        try {
            AppOpsManager ops = getSystemService(AppOpsManager.class);
            int uid = android.os.Process.myUid();
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ops.unsafeCheckOpNoThrow("android:project_media", uid, getPackageName())
                    : ops.checkOpNoThrow("android:project_media", uid, getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    private static String line(boolean ok, String what) {
        return (ok ? "[ok] " : "[  ] ") + what + "\n";
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setPadding(0, dp(8), 0, 0);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
