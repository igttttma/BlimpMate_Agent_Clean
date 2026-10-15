package com.l2dfacecontrol.host;

import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * JS interface exposed to the Android WebView for the flight-controller UART seam.
 *
 * Stage 5 intentionally does not open a serial device. The real on-device path is
 * Phase-D: open /dev/ttyAS2 at 3.3V UART levels on the Orange Pi 40-pin header
 * (TX pin 11 / RX pin 13), then ship the required Android 13 file permissions and
 * SELinux policy for that device node. This class compiles now so the page can be
 * wired against a stable native shape, but it fails closed and writes no bytes.
 *
 * The renderer should wrap this raw interface into the transport shape expected
 * by src/shared-web/flight/fc-serial-bridge.mjs (synced to assets/app/flight/ at
 * build): open(path, baud), write(base64), close().
 * Once Phase-D adds a reader thread, received FC bytes should be delivered through
 * window.__nativeFcSerialBridgeOnBytes(base64).
 */
public final class FcSerialBridge {
    public static final String DEFAULT_UART_PATH = "/dev/ttyAS2";

    private final WebView webView;
    private String configuredPath = DEFAULT_UART_PATH;
    private int configuredBaud = 115200;
    private boolean open = false;
    private String lastError = "FcSerialBridge is not open";

    public FcSerialBridge(WebView webView) {
        this.webView = webView;
    }

    @JavascriptInterface
    public boolean open(String path, int baud) {
        configuredPath = (path == null || path.trim().isEmpty()) ? DEFAULT_UART_PATH : path.trim();
        configuredBaud = baud > 0 ? baud : 115200;
        open = false;
        lastError = "FcSerialBridge UART open is not implemented on this build; "
                + "Phase-D must add the real /dev/ttyAS2 open plus Android SELinux/device permissions";
        postEvent("open_stub", false, lastError);
        return false;
    }

    @JavascriptInterface
    public boolean write(String base64) {
        if (base64 == null) {
            lastError = "write(base64) requires a base64 payload";
            postEvent("write_rejected", false, lastError);
            return false;
        }
        try {
            // Validate the JS/native byte seam now. Phase-D will write these bytes
            // to the UART; Stage 5 deliberately discards them after validation.
            Base64.decode(base64, Base64.NO_WRAP);
        } catch (Exception e) {
            lastError = "write(base64) received invalid base64 payload";
            postEvent("write_rejected", false, lastError);
            return false;
        }
        lastError = "FcSerialBridge.write is a Phase-D stub; no serial bytes were written";
        postEvent("write_stub", false, lastError);
        return false;
    }

    @JavascriptInterface
    public boolean close() {
        open = false;
        lastError = "FcSerialBridge closed";
        postEvent("close", true, lastError);
        return true;
    }

    @JavascriptInterface
    public boolean isOpen() {
        return open;
    }

    @JavascriptInterface
    public String getConfiguredPath() {
        return configuredPath;
    }

    @JavascriptInterface
    public int getConfiguredBaud() {
        return configuredBaud;
    }

    @JavascriptInterface
    public String getLastError() {
        return lastError;
    }

    @SuppressWarnings("unused")
    private void postBytes(byte[] bytes) {
        String b64 = Base64.encodeToString(bytes == null ? new byte[0] : bytes, Base64.NO_WRAP);
        final String js = "window.__nativeFcSerialBridgeOnBytes && "
                + "window.__nativeFcSerialBridgeOnBytes(\"" + b64 + "\")";
        if (webView != null) {
            webView.post(() -> webView.evaluateJavascript(js, null));
        }
    }

    private void postEvent(String type, boolean ok, String message) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("type", type);
            ev.put("ok", ok);
            ev.put("path", configuredPath);
            ev.put("baud", configuredBaud);
            ev.put("message", message == null ? "" : message);
        } catch (Exception ignored) {}
        String b64 = Base64.encodeToString(ev.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        final String js = "window.__nativeFcSerialBridgeDispatch && window.__nativeFcSerialBridgeDispatch(\""
                + b64 + "\")";
        if (webView != null) {
            webView.post(() -> webView.evaluateJavascript(js, null));
        }
    }
}
