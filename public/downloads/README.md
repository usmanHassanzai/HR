# Mobile app downloads

| File | Platform | Install method |
|------|----------|----------------|
| `scorr.apk` | Android | Download from landing page → Install |
| `Scorr-Client-Feature-Guide.pdf` | All | Client feature documentation (PDF) |
| `build-info.json` | — | Version, size, and build date for Android + iOS |
| `scorr.ipa` | iOS (developer) | Mac/Xcode/TestFlight only — not direct public install |

## Android

```bash
npm run build:android:apk
```

## iOS

**iPhone users (recommended — no Mac needed):**

1. Open **https://scorr.walfia.ai** in Safari
2. Share → **Add to Home Screen**
3. Open Scorr from the home screen icon

```bash
npm run build:ios:ipa
```

Syncs the Capacitor iOS project and updates `build-info.json` for the website.

**Native IPA (Mac + Apple Developer account):**

```bash
npm run build:ios:release
```

Or GitHub Actions → **Build iOS** on `macos-latest`.
