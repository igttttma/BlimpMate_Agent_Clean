package com.blimpmate.speaker;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * A copy of every portal clip and video (the server's "library" message), so
 * "play" starts from a local file like the Blimp's video cache does instead of
 * buffering over the network. Files are named by clip id (a clip never changes
 * once stored); one download at a time, in the background.
 */
final class MediaCache {
    private static final String TAG = "BlimpSpeaker";

    private final File dir;
    private final OkHttpClient http;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private volatile Set<String> wanted = new HashSet<>();

    MediaCache(Context context, OkHttpClient http) {
        this.dir = new File(context.getFilesDir(), "media");
        this.http = http;
        dir.mkdirs();
    }

    /** The complete local copy of a clip, or null (then play streams it). */
    File get(String id, long size) {
        File f = new File(dir, id);
        return f.isFile() && (size <= 0 || f.length() == size) ? f : null;
    }

    /** Fetch what is missing, delete what the server no longer lists. */
    void sync(JSONObject library, String host) {
        JSONArray items = library.optJSONArray("items");
        if (items == null) return;
        int port = library.optInt("http_port", 8003);
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
            ids.add(items.optJSONObject(i).optString("id"));
        }
        wanted = ids;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                String id = f.getName().replace(".part", "");
                if (!ids.contains(id)) f.delete();
            }
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            String id = item.optString("id");
            long size = item.optLong("size");
            if (get(id, size) != null) continue;
            String url = "http://" + host + ":" + port + item.optString("path");
            downloads.execute(() -> download(id, size, url, item.optString("title")));
        }
    }

    private void download(String id, long size, String url, String title) {
        if (!wanted.contains(id) || get(id, size) != null) return;
        File part = new File(dir, id + ".part");
        try (Response response = http.newCall(new Request.Builder().url(url).build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                Log.w(TAG, "Prefetch " + title + ": HTTP " + response.code());
                return;
            }
            try (InputStream in = response.body().byteStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            if (wanted.contains(id) && part.renameTo(new File(dir, id))) {
                Log.i(TAG, "Prefetched " + title + " (" + part.length() + " bytes)");
            }
        } catch (Exception e) {
            Log.w(TAG, "Prefetch " + title + " failed: " + e.getMessage());
        } finally {
            part.delete();
        }
    }

    /** How many listed clips are ready, for the status line. */
    String summary() {
        int ready = 0;
        for (String id : wanted) {
            if (new File(dir, id).isFile()) ready++;
        }
        return ready + "/" + wanted.size() + " clips ready";
    }
}
