package com.l2dfacecontrol.host;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final int REQ_RECORD_AUDIO = 1001;
    private static final long RELOAD_DELAY_MS = 5000;
    private WebView webView;
    private WakeWordBridge wakeWordBridge;
    private PermissionRequest pendingPermissionRequest;
    private String remoteDisplayUrl;
    private boolean isKioskMode;
    private final Handler reloadHandler = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );

        remoteDisplayUrl = readRemoteDisplayUrl();
        isKioskMode = remoteDisplayUrl != null && !remoteDisplayUrl.isEmpty();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        if (!isKioskMode) {
            WsBridge wsBridge = new WsBridge(webView);
            webView.addJavascriptInterface(wsBridge, "__nativeWsRaw");
            wakeWordBridge = new WakeWordBridge(this, webView);
            webView.addJavascriptInterface(wakeWordBridge, "__nativeWakeWordRaw");
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    REQ_RECORD_AUDIO
                );
            }
        }

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    android.webkit.WebResourceRequest request) {
                if (isKioskMode) return null;
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                if (!isKioskMode) {
                    view.evaluateJavascript(NATIVE_WS_GLUE + NATIVE_WAKE_WORD_GLUE, null);
                }
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                                       android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    scheduleReload();
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest request,
                                           android.webkit.WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request != null && request.isForMainFrame()) {
                    scheduleReload();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] resources = request.getResources();
                    boolean wantsAudio = false;
                    for (String r : resources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                            wantsAudio = true;
                            break;
                        }
                    }
                    if (!wantsAudio) {
                        request.deny();
                        return;
                    }
                    if (ContextCompat.checkSelfPermission(
                            MainActivity.this, Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        pendingPermissionRequest = request;
                        ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[] { Manifest.permission.RECORD_AUDIO },
                            REQ_RECORD_AUDIO
                        );
                    }
                });
            }
        });

        if (isKioskMode) {
            webView.loadUrl(remoteDisplayUrl);
        } else {
            webView.loadUrl("https://appassets.androidplatform.net/assets/app/index.html");
        }
    }

    private String readRemoteDisplayUrl() {
        try {
            InputStream is = getAssets().open("blimpmate_config.json");
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            JSONObject json = new JSONObject(sb.toString());
            String url = json.optString("remoteDisplayUrl", "");
            return url.trim().isEmpty() ? null : url.trim();
        } catch (Exception e) {
            return null;
        }
    }

    private void scheduleReload() {
        reloadHandler.removeCallbacksAndMessages(null);
        reloadHandler.postDelayed(() -> {
            if (!isDestroyed() && webView != null) {
                if (isKioskMode) {
                    webView.loadUrl(remoteDisplayUrl);
                } else {
                    webView.reload();
                }
            }
        }, RELOAD_DELAY_MS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO && pendingPermissionRequest != null) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                pendingPermissionRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            } else {
                pendingPermissionRequest.deny();
            }
            pendingPermissionRequest = null;
        }
        if (requestCode == REQ_RECORD_AUDIO && wakeWordBridge != null) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            wakeWordBridge.onAudioPermissionResult(granted);
        }
    }

    @Override
    protected void onDestroy() {
        reloadHandler.removeCallbacksAndMessages(null);
        if (wakeWordBridge != null) {
            wakeWordBridge.release();
            wakeWordBridge = null;
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    private static final String NATIVE_WS_GLUE =
        "(function(){\n" +
        "  if (!window.__nativeWsRaw) return;\n" +
        "  var listeners = new Map();\n" +
        "  function b64ToBytes(b64){\n" +
        "    var bin = atob(b64); var len = bin.length; var bytes = new Uint8Array(len);\n" +
        "    for (var i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);\n" +
        "    return bytes;\n" +
        "  }\n" +
        "  function bytesToB64(buf){\n" +
        "    var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);\n" +
        "    var s = ''; for (var i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]);\n" +
        "    return btoa(s);\n" +
        "  }\n" +
        "  window.__nativeWsDispatch = function(id, payloadB64){\n" +
        "    try {\n" +
        "      var json = new TextDecoder('utf-8').decode(b64ToBytes(payloadB64));\n" +
        "      var msg = JSON.parse(json);\n" +
        "      if (msg.type === 'binary_b64') {\n" +
        "        msg = { type: 'binary', data: b64ToBytes(msg.data).buffer };\n" +
        "      }\n" +
        "      var cb = listeners.get(id);\n" +
        "      if (cb) cb(msg);\n" +
        "    } catch (e) { console.error('[nativeWs] dispatch error', e); }\n" +
        "  };\n" +
        "  window.nativeWs = {\n" +
        "    available: true,\n" +
        "    open: function(url, headers, onEvent) {\n" +
        "      var id = window.__nativeWsRaw.open(url, JSON.stringify(headers || {}));\n" +
        "      listeners.set(id, onEvent);\n" +
        "      return Promise.resolve(id);\n" +
        "    },\n" +
        "    sendText: function(id, text) {\n" +
        "      return Promise.resolve(window.__nativeWsRaw.sendText(id, text));\n" +
        "    },\n" +
        "    sendBinary: function(id, data) {\n" +
        "      return Promise.resolve(window.__nativeWsRaw.sendBinaryB64(id, bytesToB64(data)));\n" +
        "    },\n" +
        "    close: function(id) {\n" +
        "      listeners.delete(id);\n" +
        "      return Promise.resolve(window.__nativeWsRaw.close(id));\n" +
        "    }\n" +
        "  };\n" +
        "})();";

    private static final String NATIVE_WAKE_WORD_GLUE =
        "(function(){\n" +
        "  if (!window.__nativeWakeWordRaw) return;\n" +
        "  var handlers = new Set();\n" +
        "  var lastStatus = { running: false, mode: 'sherpa-native' };\n" +
        "  function parse(raw){ try { return JSON.parse(raw || '{}'); } catch (_) { return {}; } }\n" +
        "  window.__nativeWakeWordDispatch = function(type, payloadB64){\n" +
        "    try {\n" +
        "      var payload = parse(atob(payloadB64));\n" +
        "      if (type === 'status') lastStatus = payload;\n" +
        "      if (type === 'wake') handlers.forEach(function(cb){ try { cb(payload); } catch (_) {} });\n" +
        "    } catch (e) { console.error('[nativeWakeWord] dispatch error', e); }\n" +
        "  };\n" +
        "  window.nativeWakeWord = {\n" +
        "    available: true,\n" +
        "    onWake: function(cb){ handlers.add(cb); return function(){ handlers.delete(cb); }; },\n" +
        "    start: function(){ lastStatus = parse(window.__nativeWakeWordRaw.start()); return Promise.resolve(lastStatus); },\n" +
        "    stop: function(){ lastStatus = parse(window.__nativeWakeWordRaw.stop()); return Promise.resolve(lastStatus); },\n" +
        "    getStatus: function(){ lastStatus = parse(window.__nativeWakeWordRaw.getStatus()); return lastStatus; }\n" +
        "  };\n" +
        "})();";
}
