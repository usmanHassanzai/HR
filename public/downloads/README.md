# Mobile app downloads

| File | Platform | Install method |
|------|----------|----------------|
| `scorr.apk` | Android | Download from website → Install |
| `scorr.ipa` | iOS | TestFlight / Xcode only (not direct install like APK) |

## Android

```bash
node scripts/build-android-apk.mjs
git add public/downloads/scorr.apk
git push
```

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
