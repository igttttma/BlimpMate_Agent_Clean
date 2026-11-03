package com.blimpmate.remote;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.ParcelUuid;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.Inet4Address;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Wi-Fi setup over Bluetooth, for a device that has no network yet: a BLE
 * service any phone or PC can reach with the stream server's /setup page
 * (Web Bluetooth). No pairing, no code: it's for demos.
 *
 *   STATUS   (read)  JSON: Wi-Fi state, IP, whether remote control is online
 *   NETWORKS (read)  JSON: the Wi-Fi networks the device sees, strongest first
 *   SAVED    (read)  JSON: the networks saved on the device
 *   COMMAND  (write) JSON lines, sent in chunks of any size, each ending in "\n":
 *                    {"cmd":"wifi","ssid":"..","password":".."}
 *                    {"cmd":"connect","ssid":".."}   (a saved network)
 *                    {"cmd":"forget","ssid":".."}    {"cmd":"disconnect"}
 *                    {"cmd":"wifi_power","on":true}  {"cmd":"scan"}
 *                    {"cmd":"server","url":"wss://host:8443"}
 * Switching networks is safe to try: when the new one doesn't connect within
 * 25 s, the device goes back to the one it was on (a new entry that failed is
 * forgotten).
 *
 * Joining a network silently needs the app to be the device owner (Android 10+
 * refuses addNetwork to other apps): adb shell dpm set-device-owner
 * com.blimpmate.remote/.AdminReceiver. Runs on the service's thread.
 */
public final class WifiSetup {
    private static final String TAG = "WifiSetup";
    public static final UUID SERVICE = UUID.fromString("8d5a1000-4b2e-4f6a-9c3d-2e7b5a1c0b11");
    private static final UUID STATUS = UUID.fromString("8d5a1001-4b2e-4f6a-9c3d-2e7b5a1c0b11");
    private static final UUID NETWORKS = UUID.fromString("8d5a1002-4b2e-4f6a-9c3d-2e7b5a1c0b11");
    private static final UUID COMMAND = UUID.fromString("8d5a1003-4b2e-4f6a-9c3d-2e7b5a1c0b11");
    private static final UUID SAVED = UUID.fromString("8d5a1004-4b2e-4f6a-9c3d-2e7b5a1c0b11");
    private static final long CHECK_MS = 15_000;
    private static final long JOIN_TIMEOUT_MS = 25_000;
    // One ATT attribute holds at most 512 bytes
    private static final int MAX_VALUE = 512;

    /** One line for the setup screen. */
    public static volatile String state = "Not started";

    private final Context context;
    private final Handler handler;
    private final WifiManager wifi;
    private final ConnectivityManager cm;
    private final DevicePolicyManager dpm;
    private final ComponentName admin;

    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private boolean advertising;
    private boolean stopped;
    // Long reads come in pieces (offset > 0): each piece is cut from the value read at offset 0
    private final Map<String, byte[]> readCache = new HashMap<>();
    private final Map<String, ByteArrayOutputStream> writeBuffers = new HashMap<>();
    private String lastResult = "";
    // Also on the setup screen
    public static volatile String result = "";
    private String joining;
    private Runnable joinTimeout;

    private final Runnable check = new Runnable() {
        @Override
        public void run() {
            ensureRunning();
            handler.postDelayed(this, CHECK_MS);
        }
    };

    public WifiSetup(Context context, Handler handler) {
        this.context = context.getApplicationContext();
        this.handler = handler;
        wifi = context.getSystemService(WifiManager.class);
        cm = context.getSystemService(ConnectivityManager.class);
        dpm = context.getSystemService(DevicePolicyManager.class);
        admin = new ComponentName(context, AdminReceiver.class);
    }

    public static boolean isDeviceOwner(Context context) {
        DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
        return dpm != null && dpm.isDeviceOwnerApp(context.getPackageName());
    }

    public void start() {
        stopped = false;
        handler.post(check);
    }

    public void stop() {
        stopped = true;
        handler.removeCallbacks(check);
        stopBle();
    }

    // ---- Bluetooth ----

    /** Starts (or restarts) the GATT server and advertising when they aren't running. */
    private void ensureRunning() {
        if (stopped) return;
        boolean owner = dpm.isDeviceOwnerApp(context.getPackageName());
        if (owner) grantOwnPermissions();
        BluetoothManager bm = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null) {
            setState("No Bluetooth on this device");
            return;
        }
        if (!has(Manifest.permission.BLUETOOTH_CONNECT) || !has(Manifest.permission.BLUETOOTH_ADVERTISE)) {
            setState("Needs the Bluetooth permissions (see setup)");
            return;
        }
        try {
            if (!adapter.isEnabled()) {
                stopBle();
                // Allowed to the device owner only (Android 13+)
                if (owner) adapter.enable();
                setState("Bluetooth is off");
                return;
            }
            if (server == null) {
                server = bm.openGattServer(context, gattCallback);
                if (server == null) {
                    setState("Couldn't open the Bluetooth service");
                    return;
                }
                server.addService(buildService());
            }
            if (!advertising) startAdvertising(adapter);
        } catch (SecurityException e) {
            stopBle();
            setState("Bluetooth refused: " + e.getMessage());
        }
    }

    private BluetoothGattService buildService() {
        BluetoothGattService s = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        s.addCharacteristic(new BluetoothGattCharacteristic(STATUS,
                BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
        s.addCharacteristic(new BluetoothGattCharacteristic(NETWORKS,
                BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
        s.addCharacteristic(new BluetoothGattCharacteristic(SAVED,
                BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
        s.addCharacteristic(new BluetoothGattCharacteristic(COMMAND,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE));
        return s;
    }

    private void startAdvertising(BluetoothAdapter adapter) {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            setState("This device can't advertise over Bluetooth LE");
            return;
        }
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build();
        // The 128-bit UUID nearly fills the 31-byte packet: the name goes in the scan response
        AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(SERVICE)).build();
        AdvertiseData scanResponse = new AdvertiseData.Builder().setIncludeDeviceName(true).build();
        advertising = true;
        advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback);
    }

    private void stopAdvertising() {
        if (advertiser != null && advertising) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (Exception ignored) {}
        }
        advertising = false;
    }

    private void stopBle() {
        stopAdvertising();
        if (server != null) {
            try {
                server.close();
            } catch (Exception ignored) {}
            server = null;
        }
        readCache.clear();
        writeBuffers.clear();
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            handler.post(() -> setState("Waiting for a phone (Bluetooth name: " + adapterName() + ")"));
        }

        @Override
        public void onStartFailure(int errorCode) {
            handler.post(() -> {
                // ALREADY_STARTED is fine
                if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) return;
                advertising = false;
                setState("Bluetooth advertising failed (" + errorCode + "); retrying");
            });
        }
    };

    private final BluetoothGattServerCallback gattCallback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            handler.post(() -> {
                String key = device.getAddress();
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    setState("A phone is connected");
                    startScan();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    readCache.remove(key + STATUS);
                    readCache.remove(key + NETWORKS);
                    readCache.remove(key + SAVED);
                    writeBuffers.remove(key);
                    // Some controllers stop advertising on a connection: start it again
                    stopAdvertising();
                    ensureRunning();
                }
            });
        }

        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset,
                                                BluetoothGattCharacteristic characteristic) {
            handler.post(() -> onRead(device, requestId, offset, characteristic.getUuid()));
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                                                 BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                                                 boolean responseNeeded, int offset, byte[] value) {
            handler.post(() -> onWrite(device, requestId, characteristic.getUuid(), preparedWrite, responseNeeded, value));
        }

        @Override
        public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
            handler.post(() -> {
                respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
                if (execute) processLines(device.getAddress());
                else writeBuffers.remove(device.getAddress());
            });
        }
    };

    private void onRead(BluetoothDevice device, int requestId, int offset, UUID uuid) {
        String key = device.getAddress() + uuid;
        byte[] value;
        if (offset == 0 || !readCache.containsKey(key)) {
            String json = STATUS.equals(uuid) ? statusJson() : NETWORKS.equals(uuid) ? networksJson()
                    : SAVED.equals(uuid) ? savedJson() : null;
            if (json == null) {
                respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null);
                return;
            }
            value = json.getBytes(StandardCharsets.UTF_8);
            readCache.put(key, value);
        } else {
            value = readCache.get(key);
        }
        if (offset > value.length) {
            respond(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null);
            return;
        }
        respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, Arrays.copyOfRange(value, offset, value.length));
    }

    private void onWrite(BluetoothDevice device, int requestId, UUID uuid, boolean prepared,
                         boolean responseNeeded, byte[] value) {
        if (!COMMAND.equals(uuid)) {
            if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, 0, null);
            return;
        }
        String key = device.getAddress();
        ByteArrayOutputStream buf = writeBuffers.get(key);
        if (buf == null) writeBuffers.put(key, buf = new ByteArrayOutputStream());
        if (value != null) buf.write(value, 0, value.length);
        if (buf.size() > 4096) buf.reset();
        if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value);
        // A prepared (long) write is complete only at onExecuteWrite
        if (!prepared) processLines(key);
    }

    private void processLines(String key) {
        ByteArrayOutputStream buf = writeBuffers.get(key);
        if (buf == null) return;
        String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
        int nl;
        while ((nl = text.indexOf('\n')) >= 0) {
            String line = text.substring(0, nl).trim();
            text = text.substring(nl + 1);
            if (!line.isEmpty()) {
                try {
                    onCommand(new JSONObject(line));
                } catch (Exception e) {
                    setResult("Bad command: " + e.getMessage());
                }
            }
        }
        buf.reset();
        byte[] rest = text.getBytes(StandardCharsets.UTF_8);
        buf.write(rest, 0, rest.length);
    }

    private void respond(BluetoothDevice device, int requestId, int status, int offset, byte[] value) {
        try {
            if (server != null) server.sendResponse(device, requestId, status, offset, value);
        } catch (SecurityException e) {
            Log.w(TAG, "sendResponse", e);
        }
    }

    // ---- commands ----

    public void onCommand(JSONObject cmd) {
        switch (cmd.optString("cmd")) {
            case "wifi":
                join(cmd.optString("ssid"), cmd.optString("password"));
                break;
            case "connect":
                connectSaved(cmd.optString("ssid"));
                break;
            case "forget":
                forget(cmd.optString("ssid"));
                break;
            case "disconnect":
                cancelJoin();
                wifi.disconnect();
                setResult("Disconnected");
                break;
            case "wifi_power":
                setWifiPower(cmd.optBoolean("on", true));
                break;
            case "scan":
                startScan();
                break;
            case "server":
                String url = cmd.optString("url").trim();
                if (url.startsWith("wss://") || url.startsWith("ws://")) {
                    Config.save(context, url);
                    RemoteService.reconnect(context);
                    setResult("Server set to " + url);
                }
                break;
            default:
                setResult("Unknown command");
        }
    }

    @SuppressWarnings("deprecation")
    private void join(String ssid, String password) {
        if (ssid.isEmpty()) {
            setResult("No network name");
            return;
        }
        boolean owner = dpm.isDeviceOwnerApp(context.getPackageName());
        try {
            if (!wifi.isWifiEnabled()) wifi.setWifiEnabled(true);
            // Replace an old entry for the same network (it may have a stale password)
            WifiConfiguration old = saved(ssid);
            if (old != null) wifi.removeNetwork(old.networkId);

            WifiConfiguration c = new WifiConfiguration();
            c.SSID = quote(ssid);
            ScanResult seen = strongest(ssid);
            c.hiddenSSID = seen == null;
            String caps = seen == null ? "" : seen.capabilities;
            if (password.isEmpty()) {
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            } else if (Build.VERSION.SDK_INT >= 30 && caps.contains("SAE") && !caps.contains("PSK")) {
                c.setSecurityParams(WifiConfiguration.SECURITY_TYPE_SAE);
                c.preSharedKey = quote(password);
            } else {
                c.preSharedKey = quote(password);
            }
            int id = wifi.addNetwork(c);
            if (id == -1) {
                setResult(owner ? "Android refused the network settings"
                        : "Android won't let the app join Wi-Fi. Run once: adb shell dpm set-device-owner "
                          + context.getPackageName() + "/.AdminReceiver");
                return;
            }
            switchTo(ssid, id, true);
        } catch (SecurityException e) {
            setResult("Android refused: " + e.getMessage());
        }
    }

    private void connectSaved(String ssid) {
        try {
            if (!wifi.isWifiEnabled()) wifi.setWifiEnabled(true);
            WifiConfiguration c = saved(ssid);
            if (c == null) {
                setResult(ssid + " isn't saved on the device");
                return;
            }
            switchTo(ssid, c.networkId, false);
        } catch (SecurityException e) {
            setResult("Android refused: " + e.getMessage());
        }
    }

    /** Leaves the current network for this one; goes back when it doesn't connect in time. */
    @SuppressWarnings("deprecation")
    private void switchTo(String ssid, int id, boolean isNew) {
        cancelJoin();
        WifiInfo info = wifi.getConnectionInfo();
        int current = info == null ? -1 : info.getNetworkId();
        int previous = current == id ? -1 : current;
        joining = ssid;
        wifi.enableNetwork(id, true);
        wifi.reconnect();
        setResult("Joining " + ssid);
        joinTimeout = () -> {
            if (!ssid.equals(joining)) return;
            joining = null;
            joinTimeout = null;
            // A new entry that failed is dropped, so Android doesn't keep trying it
            if (isNew) wifi.removeNetwork(id);
            String back = "";
            if (previous != -1) {
                wifi.enableNetwork(previous, true);
                wifi.reconnect();
                back = "; going back to the previous network";
            }
            setResult("Couldn't join " + ssid + (isNew ? " (wrong password, or too far away?)" : "") + back);
        };
        handler.postDelayed(joinTimeout, JOIN_TIMEOUT_MS);
        handler.postDelayed(joinPoll, 2000);
    }

    // Notices the join without waiting for the phone to read the status
    private final Runnable joinPoll = new Runnable() {
        @Override
        public void run() {
            if (joining == null) return;
            Network net = activeWifi();
            checkJoined(currentSsid(), net == null ? null : ipv4(net));
            if (joining != null) handler.postDelayed(this, 2000);
        }
    };

    private void checkJoined(String ssid, String ip) {
        if (joining != null && joining.equals(ssid) && ip != null) {
            setResult("Joined " + joining);
            cancelJoin();
        }
    }

    private void cancelJoin() {
        if (joinTimeout != null) handler.removeCallbacks(joinTimeout);
        joinTimeout = null;
        joining = null;
        handler.removeCallbacks(joinPoll);
    }

    private void forget(String ssid) {
        try {
            WifiConfiguration c = saved(ssid);
            if (c == null) {
                setResult(ssid + " isn't saved on the device");
                return;
            }
            if (ssid.equals(joining)) cancelJoin();
            setResult(wifi.removeNetwork(c.networkId) ? "Forgot " + ssid : "Android refused to forget " + ssid);
        } catch (SecurityException e) {
            setResult("Android refused: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void setWifiPower(boolean on) {
        cancelJoin();
        try {
            boolean ok = wifi.setWifiEnabled(on);
            setResult(ok ? (on ? "Wi-Fi turned on" : "Wi-Fi turned off") : "Android refused to switch Wi-Fi");
        } catch (SecurityException e) {
            setResult("Android refused: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private WifiConfiguration saved(String ssid) {
        try {
            List<WifiConfiguration> list = wifi.getConfiguredNetworks();
            if (list != null) {
                for (WifiConfiguration c : list) {
                    if (quote(ssid).equals(c.SSID)) return c;
                }
            }
        } catch (SecurityException ignored) {}
        return null;
    }

    /** ["ssid", ...]; empty when Android hides them from the app (not device owner). */
    @SuppressWarnings("deprecation")
    private String savedJson() {
        JSONArray out = new JSONArray();
        // Android 12+ lists a network once per security type it accepts (open + OWE,
        // WPA2 + WPA3 for auto-upgrade): one name each is enough
        java.util.Set<String> seen = new java.util.HashSet<>();
        try {
            List<WifiConfiguration> list = wifi.getConfiguredNetworks();
            if (list != null) {
                for (WifiConfiguration c : list) {
                    String name = unquote(c.SSID);
                    if (name == null || name.isEmpty() || !seen.add(name)) continue;
                    if (out.toString().length() + name.length() + 4 > MAX_VALUE) break;
                    out.put(name);
                }
            }
        } catch (SecurityException ignored) {}
        return out.toString();
    }

    private void startScan() {
        try {
            // Throttled by Android (4 scans in 2 min); the cached results are used anyway
            wifi.startScan();
        } catch (SecurityException ignored) {}
    }

    // ---- status ----

    private String statusJson() {
        try {
            JSONObject w = new JSONObject();
            w.put("on", wifi.isWifiEnabled());
            String ssid = currentSsid();
            Network net = activeWifi();
            String ip = net == null ? null : ipv4(net);
            if (ssid != null && net != null) {
                w.put("ssid", ssid);
                NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                w.put("internet", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
                if (ip != null) w.put("ip", ip);
            }
            checkJoined(ssid, ip);
            Network any = cm.getActiveNetwork();
            return new JSONObject()
                    .put("device", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("wifi", w)
                    // Any network (Ethernet, USB...) counts for "has internet"
                    .put("network", any != null)
                    .put("joining", joining == null ? JSONObject.NULL : joining)
                    .put("online", RemoteService.online)
                    .put("remote", RemoteService.status)
                    .put("server", Config.load(context).url)
                    .put("owner", dpm.isDeviceOwnerApp(context.getPackageName()))
                    .put("result", lastResult)
                    .toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    /** [[ssid, signal 0-4, secured], ...], strongest first, within one attribute. */
    private String networksJson() {
        List<ScanResult> results;
        try {
            results = wifi.getScanResults();
        } catch (SecurityException e) {
            results = null;
        }
        Map<String, ScanResult> best = new HashMap<>();
        if (results != null) {
            for (ScanResult r : results) {
                String name = r.SSID;
                if (name == null || name.isEmpty()) continue;
                ScanResult b = best.get(name);
                if (b == null || r.level > b.level) best.put(name, r);
            }
        }
        List<ScanResult> list = new ArrayList<>(best.values());
        list.sort((a, b) -> b.level - a.level);
        JSONArray out = new JSONArray();
        for (ScanResult r : list) {
            String caps = r.capabilities == null ? "" : r.capabilities;
            boolean secured = caps.contains("WPA") || caps.contains("WEP") || caps.contains("SAE") || caps.contains("PSK");
            JSONArray item = new JSONArray().put(r.SSID).put(WifiManager.calculateSignalLevel(r.level, 5)).put(secured ? 1 : 0);
            if (out.toString().length() + item.toString().length() + 1 > MAX_VALUE) break;
            out.put(item);
        }
        return out.toString();
    }

    private ScanResult strongest(String ssid) {
        ScanResult best = null;
        try {
            List<ScanResult> results = wifi.getScanResults();
            if (results != null) {
                for (ScanResult r : results) {
                    if (ssid.equals(r.SSID) && (best == null || r.level > best.level)) best = r;
                }
            }
        } catch (SecurityException ignored) {}
        return best;
    }

    @SuppressWarnings("deprecation")
    private String currentSsid() {
        WifiInfo info = wifi.getConnectionInfo();
        if (info == null || info.getNetworkId() == -1) return null;
        String s = info.getSSID();
        if (s == null || s.equals(WifiManager.UNKNOWN_SSID)) return null;
        return unquote(s);
    }

    private Network activeWifi() {
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return n;
        }
        return null;
    }

    private String ipv4(Network n) {
        LinkProperties lp = cm.getLinkProperties(n);
        if (lp == null) return null;
        for (LinkAddress a : lp.getLinkAddresses()) {
            if (a.getAddress() instanceof Inet4Address) return a.getAddress().getHostAddress();
        }
        return null;
    }

    private String adapterName() {
        try {
            BluetoothManager bm = context.getSystemService(BluetoothManager.class);
            return bm.getAdapter().getName();
        } catch (Exception e) {
            return "?";
        }
    }

    // ---- permissions ----

    /** The device owner grants its own runtime permissions, so no adb pm grant is needed. */
    private void grantOwnPermissions() {
        List<String> perms = new ArrayList<>(Arrays.asList(
                Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION));
        if (Build.VERSION.SDK_INT >= 31) {
            perms.add(Manifest.permission.BLUETOOTH_CONNECT);
            perms.add(Manifest.permission.BLUETOOTH_ADVERTISE);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.NEARBY_WIFI_DEVICES);
            perms.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        for (String p : perms) {
            if (has(p)) continue;
            try {
                dpm.setPermissionGrantState(admin, context.getPackageName(), p,
                        DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            } catch (Exception e) {
                Log.w(TAG, "grant " + p + ": " + e.getMessage());
            }
        }
        // Wi-Fi scan results need location turned on
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                dpm.setLocationEnabled(admin, true);
            } catch (Exception e) {
                Log.w(TAG, "location: " + e.getMessage());
            }
        }
    }

    private boolean has(String permission) {
        if (Build.VERSION.SDK_INT < 31 && permission.startsWith("android.permission.BLUETOOTH_")) return true;
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void setResult(String s) {
        Log.i(TAG, "result: " + s);
        lastResult = s;
        result = s;
    }

    private void setState(String s) {
        if (!s.equals(state)) Log.i(TAG, s);
        state = s;
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    private static String unquote(String s) {
        if (s == null) return null;
        return s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.substring(1, s.length() - 1) : s;
    }
}
