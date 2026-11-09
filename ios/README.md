# Scorr iOS (native Capacitor app)

Real installable iPhone/iPad app — **not** Add to Home Screen. Same web UI as Android via `https://scorr.walfia.ai/?app=1`, plus native `AttendancePing` (geofence auto attendance, Keychain MFA trust).

## Requirements

- macOS with **Xcode** + Apple Developer account
- Bundle ID: `ai.walfia.scorr`
- Enable **Access WiFi Information** on the App ID (entitlement already in `App.entitlements`)

## Build & install

```bash
# From repo root (any OS): sync web + ios/ project
npm run build:ios:ipa

# On a Mac: open Xcode, plug in iPhone, Run
npm run cap:ios

# On a Mac: archive + export IPA → public/downloads/scorr.ipa
npm run build:ios:release
```

Set your team in `ios/ExportOptions.plist` (`teamID`) and Xcode Signing & Capabilities before `--archive`.

## Distribution

| Method | Who can install |
|--------|-----------------|
| Xcode Run / Development | Connected devices you own |
| Ad Hoc IPA + OTA manifest | Devices whose UDID is in the profile |
| TestFlight | Invited testers |
| App Store | Public (after review) |

OTA (Ad Hoc): after IPA is published, Safari opens  
`itms-services://?action=download-manifest&url=https://scorr.walfia.ai/downloads/ios/manifest.plist`

Android, desktop, and browser builds are separate and unchanged by this folder.
