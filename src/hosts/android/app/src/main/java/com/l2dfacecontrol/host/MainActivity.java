package com.l2dfacecontrol.host;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
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
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int REQ_RECORD_AUDIO = 1001;
    // WebView getUserMedia requests (mic and/or camera) waiting for a runtime permission
    private static final int REQ_WEB_MEDIA = 1002;
    private static final long RELOAD_DELAY_MS = 5000;
    private WebView webView;
    private WakeWordBridge wakeWordBridge;
    private WsBridge wsBridge;
    private CallModeVolume callModeVolume;
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

        // Debug builds only: lets chrome://inspect / CDP attach to the WebView.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

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
            wsBridge = new WsBridge(webView);
            webView.addJavascriptInterface(wsBridge, "__nativeWsRaw");
            wakeWordBridge = new WakeWordBridge(this, webView);
            webView.addJavascriptInterface(wakeWordBridge, "__nativeWakeWordRaw");
            // Media + call volume at max; replies (mic open, call mode) as loud as the greeting
            callModeVolume = new CallModeVolume(this);
            callModeVolume.start();
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
                    // A reload (e.g. after changing the backend) leaves the old
                    // page's sockets open; the new page can't reach them.
                    if (wsBridge != null) wsBridge.closeAll();
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
                    // Microphone (conversation) and camera (camera.take_photo tool) only
                    List<String> missing = new ArrayList<>();
                    boolean wantsMedia = false;
                    for (String r : request.getResources()) {
                        String permission = androidPermissionFor(r);
                        if (permission == null) continue;
                        wantsMedia = true;
                        if (ContextCompat.checkSelfPermission(MainActivity.this, permission)
                                != PackageManager.PERMISSION_GRANTED) {
                            missing.add(permission);
                        }
                    }
                    if (!wantsMedia) {
                        request.deny();
                    } else if (missing.isEmpty()) {
                        grantPermitted(request);
                    } else {
                        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
                        pendingPermissionRequest = request;
                        ActivityCompat.requestPermissions(
                            MainActivity.this,
                            missing.toArray(new String[0]),
                            REQ_WEB_MEDIA
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

    private static String androidPermissionFor(String webResource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(webResource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(webResource)) return Manifest.permission.CAMERA;
        return null;
    }

    /** Grants the media resources whose Android permission is held; denies if none. */
    private void grantPermitted(PermissionRequest request) {
        List<String> granted = new ArrayList<>();
        for (String r : request.getResources()) {
            String permission = androidPermissionFor(r);
            if (permission != null && ContextCompat.checkSelfPermission(this, permission)
                    == PackageManager.PERMISSION_GRANTED) {
                granted.add(r);
            }
        }
        if (granted.isEmpty()) {
            request.deny();
        } else {
            request.grant(granted.toArray(new String[0]));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WEB_MEDIA && pendingPermissionRequest != null) {
            grantPermitted(pendingPermissionRequest);
            pendingPermissionRequest = null;
        }
        if ((requestCode == REQ_RECORD_AUDIO || requestCode == REQ_WEB_MEDIA) && wakeWordBridge != null) {
            for (int i = 0; i < permissions.length && i < grantResults.length; i++) {
                if (Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                    wakeWordBridge.onAudioPermissionResult(grantResults[i] == PackageManager.PERMISSION_GRANTED);
                }
            }
        }
    }

    @Override
    protected void onDestroy() {
        reloadHandler.removeCallbacksAndMessages(null);
        if (callModeVolume != null) {
            callModeVolume.stop();
            callModeVolume = null;
        }
        if (wakeWordBridge != null) {
            wakeWordBridge.release();
            wakeWordBridge = null;
        }
        if (wsBridge != null) {
            wsBridge.closeAll();
            wsBridge = null;
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
        "  var lastStatus = { running: false, mode: 'openwakeword' };\n" +
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
        "    startKeywords: function(set){ lastStatus = parse(window.__nativeWakeWordRaw.startKeywords(String(set))); return Promise.resolve(lastStatus); },\n" +
        "    stop: function(){ lastStatus = parse(window.__nativeWakeWordRaw.stop()); return Promise.resolve(lastStatus); },\n" +
        "    getStatus: function(){ lastStatus = parse(window.__nativeWakeWordRaw.getStatus()); return lastStatus; }\n" +
        "  };\n" +
        "})();";
}
