# Scorr Mobile Apps (Android APK + iOS)

Your HR web app is wrapped with **Capacitor** — the same React codebase runs in native Android and iOS shells.

## Quick overview

| Platform | How users install | Build where |
|----------|-------------------|-------------|
| **Android** | Download `.apk` from website → Install | Linux / Mac / Windows |
| **iPhone/iPad** | Safari → Share → **Add to Home Screen** (PWA) | No build needed |
| **iOS native** | App Store / TestFlight (optional) | **Mac + Xcode only** |

## One-time setup

```bash
npm install
node scripts/setup-mobile.mjs
```

Requirements for **Android APK**:
- **JDK 21+** — auto-installed to `.tools/jdk-21` by the build script (no sudo)
- **Android SDK** — install [Android Studio](https://developer.android.com/studio) or command-line tools
- Set `ANDROID_HOME` if SDK is not at `~/Android/Sdk`

## Build Android APK (for website download)

```bash
node scripts/build-android-apk.mjs
```

This will:
1. Build the web app (`npm run build`)
2. Sync to the Android project (`cap sync`)
3. Run Gradle to produce an APK
4. Copy it to `public/downloads/scorr.apk`

Deploy your website — users download from **Mobile App** on the landing page.

### Signed release APK (production)

```bash
keytool -genkey -v -keystore scorr-release.keystore -alias scorr -keyalg RSA -keysize 2048 -validity 10000
```

Create `android/keystore.properties`:

```properties
storeFile=../scorr-release.keystore
storePassword=YOUR_PASSWORD
keyAlias=scorr
keyPassword=YOUR_PASSWORD
```

Then:

```bash
node scripts/build-android-apk.mjs --release
```

For Google Play Store, upload the release APK/AAB via [Google Play Console](https://play.google.com/console).

## iOS

### Option A — PWA (recommended, no Mac needed)

Users on iPhone:
1. Open **https://scorr.walfia.ai** in **Safari**
2. Tap **Share** → **Add to Home Screen**
3. Opens full-screen like an app

Already configured: `manifest.webmanifest`, service worker, Apple meta tags.

### Option B — Native iOS app (App Store)

Requires:
- Mac with **Xcode**
- **Apple Developer Program** ($99/year)

```bash
npm run build
npx cap sync ios
npm run cap:ios    # opens Xcode
```

In Xcode: select team → Product → Archive → Distribute to App Store or TestFlight.

## Development workflow

```bash
npm run dev                    # web dev server
npm run build:mobile           # build + cap sync both platforms
npm run cap:android            # open Android Studio
npm run cap:ios                # open Xcode (Mac only)
```

Live reload on device: see [Capacitor live reload docs](https://capacitorjs.com/docs/guides/live-reload).

## GPS / permissions

Configured automatically:
- **Android:** `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` in `AndroidManifest.xml`
- **iOS:** location usage strings in `Info.plist`
- App uses `@capacitor/geolocation` when running as native app

## App identity

| Setting | Value |
|---------|--------|
| App ID | `ai.walfia.scorr` |
| App name | Scorr |
| Web bundle | `dist/` (Vite build) |

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run build:mobile` | Web build + Capacitor sync |
| `npm run cap:android` | Open Android Studio |
| `npm run cap:ios` | Open Xcode |
| `node scripts/setup-mobile.mjs` | First-time setup + env check |
| `node scripts/build-android-apk.mjs` | Build APK → `public/downloads/scorr.apk` |
