# BlimpMate Remote

Remote screen control of the Blimp's Android, like scrcpy but through the
stream server: a signed-in viewer at `https://<stream-server>:8443/screen`
watches the screen and taps, swipes and types on it. A separate app from the
Blimp app (package `com.blimpmate.remote`), so it keeps running when the Blimp
app crashes or updates, and can bring it back to the front.

Written for **Android 13**. On Android 14+ the system asks for screen-capture
permission on every session, which this agent doesn't handle.

## How it works

- Starts at boot (and after an update) as a foreground service that stays
  connected to the stream server (`role=screen`, no token: the server takes the
  first device and refuses others), reconnecting with backoff and immediately
  when a network comes up.
- When a viewer asks for the screen it gets screen capture (no dialog once the
  `PROJECT_MEDIA` app-op is granted), mirrors the screen into a WebRTC video track
  and opens an `input` data channel. Capture stops when the viewer leaves; the
  status bar's cast icon shows while someone watches, and the screen is kept on.
- Input goes through the accessibility service `InputService`: gestures
  (replayed with their timing), Back/Home/Recents/Notifications, and text typed
  into the focused field (native fields and web pages).
- Video and input go peer to peer, or through TURN; the server only relays the
  connection setup.

## Build and install

```
gradlew :remote:assembleDebug
adb install -r remote/build/outputs/apk/debug/remote-debug.apk
```

The stream server's certificate is taken from the Blimp app
(`app/src/main/res/raw/stream_server_cert.pem`) at build time.

## One-time setup on the device (adb)

The setup screen (open "BlimpMate Remote") shows each item with its command.

```
# Server address (or type it into the setup screen)
adb shell am start -n com.blimpmate.remote/.SetupActivity --es url wss://<host>:8443

# Input control. Android 13 blocks turning this on in Settings for sideloaded apps.
adb shell settings put secure enabled_accessibility_services com.blimpmate.remote/.InputService
adb shell settings put secure accessibility_enabled 1

# Screen capture without the "Start now" dialog
adb shell appops set com.blimpmate.remote PROJECT_MEDIA allow

# Open the capture request (and the Blimp app) from the background
adb shell appops set com.blimpmate.remote SYSTEM_ALERT_WINDOW allow

# Not stopped by battery saving
adb shell dumpsys deviceidle whitelist +com.blimpmate.remote

# Status notification
adb shell pm grant com.blimpmate.remote android.permission.POST_NOTIFICATIONS
```

The app must have been opened once (any install leaves it "stopped" until then)
before Android delivers the boot broadcast to it. Settings above survive reboots
and app updates.

Note: `enabled_accessibility_services` is a list. If the device already has
other accessibility services, append ours with a `:` separator instead of
replacing the list.

## Viewer controls

Click to tap, hold to long-press, drag to swipe, scroll wheel to scroll.
Right-click is Back, middle-click is Home. Click the screen, then type (Backspace
and Enter work); paste works too. Toolbar: Back, Home, Recents, Notifications,
Blimp app, Enter, quality (Low 480p/15 fps, Medium 720p/30 fps, High 1080p/30 fps).
