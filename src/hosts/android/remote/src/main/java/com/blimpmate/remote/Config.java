package com.blimpmate.remote;

import android.content.Context;

/** Where the stream server is (set in SetupActivity or by adb). */
public final class Config {
    private static final String PREFS = "remote";

    public final String url;

    private Config(String url) {
        this.url = url;
    }

    public static Config load(Context context) {
        return new Config(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("url", ""));
    }

    public static void save(Context context, String url) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("url", url.trim()).apply();
    }

    public boolean isComplete() {
        return !url.isEmpty();
    }

    /** wss://host:port/ws?role=screen */
    public String socketUrl() {
        String base = url.endsWith("/ws") ? url : url.replaceAll("/+$", "") + "/ws";
        return base + "?role=screen";
    }
}
