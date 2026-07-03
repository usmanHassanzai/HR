# Scorr Mobile Apps (Android APK + iOS)

Your HR web app is wrapped with **Capacitor** — the same React codebase runs in native Android and iOS shells.

## Quick overview

| Platform | How users install | Build where |
|----------|-------------------|-------------|
| **Android** | Download `.apk` from website → Install | Linux / Mac / Windows |
| **iPhone/iPad (easiest)** | Safari → Share → **Add to Home Screen** | No build needed |
| **iOS native (TestFlight/App Store)** | TestFlight link or App Store | **Mac + Xcode** or GitHub Actions |

## One-time setup

```bash
npm install
node scripts/setup-mobile.mjs
```

## Build Android APK

```bash
node scripts/build-android-apk.mjs
# or: npm run build:android:apk
```

Output: `public/downloads/scorr.apk` — deploy website for direct download.

## Build iOS app

### Option A — Install on iPhone today (recommended, no Mac)

Users on iPhone/iPad:

1. Open **https://scorr.walfia.ai** in **Safari**
2. Tap **Share** → **Add to Home Screen**
3. Open **Scorr** from home screen → sign in (same as Android APK)

Opens full-screen with login screen — not the marketing website.

### Option B — Native iOS (Capacitor + Xcode)

**Sync project (Linux/Mac/Windows):**

```bash
node scripts/build-ios-ipa.mjs
# or: npm run build:ios:ipa
```

**Full IPA export (Mac only):**

```bash
node scripts/build-ios-ipa.mjs --archive
# or: npm run build:ios:release
```

Requirements:

- Mac with **Xcode** (App Store)
- **Apple Developer Program** ($99/year) for TestFlight / App Store
- Edit `ios/ExportOptions.plist` with your Team ID

Then in Xcode:

```bash
npm run cap:ios
```

Product → Run (device) | Archive → TestFlight / App Store

### Option C — GitHub Actions (no local Mac)

Push to GitHub → **Actions** → **Build iOS** — compiles on `macos-latest`.

For TestFlight upload, add Apple signing secrets (see `.github/workflows/build-ios.yml`).

### TestFlight link on website

After publishing to TestFlight, add to Vercel env:

```
VITE_TESTFLIGHT_URL=https://testflight.apple.com/join/XXXXXX
```

The download page shows an **Install via TestFlight** button.

## Build both platforms

```bash
npm run build:mobile:apps
```

## Important: iOS vs Android distribution

| | Android APK | iOS |
|---|-------------|-----|
| Direct website download | ✅ Yes | ❌ Apple blocks this |
| Home screen PWA | ✅ | ✅ **Best for iPhone** |
| TestFlight | — | ✅ |
| App Store | Play Store | ✅ |

## GPS / permissions

- **Android:** `ACCESS_FINE_LOCATION`, background location in `AndroidManifest.xml`
- **iOS:** Location usage strings + background mode in `Info.plist`
- App uses `@capacitor/geolocation` on native; same shift + attendance features

## App identity

| Setting | Value |
|---------|--------|
| App ID | `ai.walfia.scorr` |
| App name | Scorr |
| Web bundle | `dist/` (Vite build) |

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run build:android:apk` | Build APK → `public/downloads/scorr.apk` |
| `npm run build:ios:ipa` | Web build + sync iOS project |
| `npm run build:ios:release` | Export IPA on Mac |
| `npm run build:mobile:apps` | Android APK + iOS sync |
| `npm run cap:ios` | Open Xcode |
| `npm run cap:android` | Open Android Studio |
