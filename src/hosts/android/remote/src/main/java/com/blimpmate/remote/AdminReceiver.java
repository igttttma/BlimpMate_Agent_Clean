package com.blimpmate.remote;

import android.app.admin.DeviceAdminReceiver;

/**
 * Makes the app eligible as device owner, which lets WifiSetup join Wi-Fi
 * networks without a dialog. Set once with adb:
 *   adb shell dpm set-device-owner com.blimpmate.remote/.AdminReceiver
 * Undo (needed before uninstalling):
 *   adb shell am start -n com.blimpmate.remote/.SetupActivity --ez release_owner true
 */
public final class AdminReceiver extends DeviceAdminReceiver {
}
