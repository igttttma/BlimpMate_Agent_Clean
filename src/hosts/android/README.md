# Android Host

Minimal command-line Android WebView shell.

This host loads the same shared web runtime used by Electron:

- `src/shared-web`
- `src/core`
- `src/bridge`
- `black_origin_face`

USB / flight-control services are intentionally out of scope for this app.

## Build

Install Android SDK command-line tools and a JDK, then from this directory:

```bash
gradle wrapper
./gradlew assembleDebug
```

On Windows:

```powershell
gradle wrapper
.\gradlew.bat assembleDebug
```

### Local Windows build

This workspace uses a local Temurin JDK 17 under `tools/jdk-17.0.20+8`.
The JDK directory is ignored by Git because it contains large,
machine-specific binaries. Android Studio's bundled Java 25 is too new for the
current Gradle version. From the repository root, run:

```powershell
npm run build:renderer
npm run test:wake
git diff --check

$env:JAVA_HOME=(Resolve-Path ".\tools\jdk-17.0.20+8").Path
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
Set-Location .\src\hosts\android
.\gradlew.bat assembleDebug
```

The debug APK is written to:

```text
src\hosts\android\app\build\outputs\apk\debug\app-debug.apk
```

The Gradle build copies shared assets into the APK:

- `src/shared-web` -> `assets/app`
- `src/core` -> `assets/core`
- `src/bridge` -> `assets/bridge`
- `black_origin_face` -> `assets/black_origin_face`

The WebView loads:

```text
https://appassets.androidplatform.net/assets/app/index.html
```

`WebViewAssetLoader` serves local assets through HTTPS-style URLs, so Live2D model fetches avoid `file://` restrictions.
