package com.blimpmate.remote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the agent when the device boots and after the app is updated. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            RemoteService.start(context);
        }
    }
}
