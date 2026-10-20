package com.l2dfacecontrol.host;

import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * JS interface exposed as window.__nativeWsRaw in the WebView. The renderer
 * does not call it directly — the small JS glue installed in the page wraps
 * it into the same shape as Electron's window.nativeWs.
 */
public final class WsBridge {
    private final WebView webView;
    private final OkHttpClient client;
    private final Map<Integer, WebSocket> sockets = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);

    public WsBridge(WebView webView) {
        this.webView = webView;
        this.client = new OkHttpClient.Builder()
                .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    @JavascriptInterface
    public int open(String url, String headersJson) {
        final int id = nextId.getAndIncrement();
        Request.Builder rb = new Request.Builder().url(url);
        try {
            JSONObject h = new JSONObject(headersJson);
            Iterator<String> keys = h.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = h.optString(k, "");
                if (!v.isEmpty()) rb.addHeader(k, v);
            }
        } catch (Exception ignored) {}

        WebSocket ws = client.newWebSocket(rb.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                postEvent(id, "{\"type\":\"open\"}");
            }
            @Override
            public void onMessage(WebSocket webSocket, String text) {
                JSONObject ev = new JSONObject();
                try {
                    ev.put("type", "text");
                    ev.put("data", text);
                } catch (Exception ignored) {}
                postEvent(id, ev.toString());
            }
            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                String b64 = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
                JSONObject ev = new JSONObject();
                try {
                    ev.put("type", "binary_b64");
                    ev.put("data", b64);
                } catch (Exception ignored) {}
                postEvent(id, ev.toString());
            }
            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }
            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                sockets.remove(id);
                JSONObject ev = new JSONObject();
                try {
                    ev.put("type", "close");
                    ev.put("code", code);
                    ev.put("reason", reason == null ? "" : reason);
                    ev.put("wasClean", true);
                } catch (Exception ignored) {}
                postEvent(id, ev.toString());
            }
            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                sockets.remove(id);
                JSONObject ev = new JSONObject();
                try {
                    ev.put("type", "error");
                    ev.put("message", t.getMessage() == null ? "unknown" : t.getMessage());
                } catch (Exception ignored) {}
                postEvent(id, ev.toString());
                JSONObject close = new JSONObject();
                try {
                    close.put("type", "close");
                    close.put("code", response != null ? response.code() : 1006);
                    close.put("reason", t.getMessage() == null ? "" : t.getMessage());
                    close.put("wasClean", false);
                } catch (Exception ignored) {}
                postEvent(id, close.toString());
            }
        });
        sockets.put(id, ws);
        return id;
    }

    @JavascriptInterface
    public boolean sendText(int id, String text) {
        WebSocket ws = sockets.get(id);
        if (ws == null) return false;
        return ws.send(text);
    }

    @JavascriptInterface
    public boolean sendBinaryB64(int id, String base64) {
        WebSocket ws = sockets.get(id);
        if (ws == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
            return ws.send(ByteString.of(bytes, 0, bytes.length));
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean close(int id) {
        WebSocket ws = sockets.remove(id);
        if (ws == null) return false;
        try {
            ws.close(1000, "client_close");
        } catch (Exception ignored) {}
        return true;
    }

    /** Closes every socket; called when the page (re)loads so old ones don't linger. */
    public void closeAll() {
        for (Integer id : sockets.keySet()) {
            WebSocket ws = sockets.remove(id);
            if (ws != null) {
                try { ws.cancel(); } catch (Exception ignored) {}
            }
        }
    }

    private void postEvent(int id, String json) {
        // Escape for JS string literal — JSON already escapes quotes & backslashes
        // but we still need to wrap it carefully. Use Base64 to avoid any quoting.
        String b64 = Base64.encodeToString(json.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        final String js = "window.__nativeWsDispatch && window.__nativeWsDispatch("
                + id + ", \"" + b64 + "\")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
