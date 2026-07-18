# Mobile app downloads

| File | Platform | Install method |
|------|----------|----------------|
| `scorr.apk` | Android | Download from landing page → Install |
| `build-info.json` | — | Version, size, and build date shown on the website |
| `scorr.ipa` | iOS | TestFlight / Xcode only (not direct install like APK) |

## Android

```bash
npm run build:android:apk
```

This copies `scorr.apk` to `public/downloads/` and refreshes `build-info.json`.
Deploy the site so `/downloads/scorr.apk` is live on the landing page.

## iOS

**Option A — iPhone users (no Mac):** Safari → Share → Add to Home Screen

**Option B — Native iOS (Mac + Xcode):**

```bash
node scripts/build-ios-ipa.mjs          # sync project (any OS)
node scripts/build-ios-ipa.mjs --archive  # IPA on macOS only
```

Or open Xcode:

```bash
npm run cap:ios
```

**Option C — GitHub Actions:** Actions → Build iOS (runs on macOS)

For TestFlight, set `VITE_TESTFLIGHT_URL` in Vercel env vars after publishing.
