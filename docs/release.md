# Scorr release & automatic updates

## Web-first (default)

Android, iOS (Capacitor), and desktop Electron load **`https://scorr.walfia.ai/?app=1`**.

Most product changes ship with a **Vercel deploy only** — no new APK / IPA / installer.

Users see **“New version available — Refresh”** when `webBuildId` in `/downloads/version.json` advances (browser, iOS Home Screen, and inside native shells).

### Needs a NEW native build

| Change | Web-only | New Android APK | New desktop installer | New iOS IPA |
| --- | --- | --- | --- | --- |
| UI / RPC / attendance rules / settings | ✅ | — | — | — |
| Capacitor plugins / Java / Swift native code | — | ✅ | — | ✅ |
| Android permissions / FileProvider / updater | — | ✅ | — | — |
| Electron main/preload / auto-updater | — | — | ✅ | — |
| App icon, splash, package id, signing | — | ✅ | ✅ | ✅ |
| Play Store / App Store listing binaries | — | ✅ | — | ✅ |

## One command

```bash
npm run release
# flags: --skip-android --skip-desktop --skip-deploy --skip-ios --bump-patch
```

What it does:

1. Ensures permanent Android keystore at `~/.scorr/` (+ backup `~/Scorr-keystore-backup/`)
2. Bumps `versionCode`, builds **release-signed** APK → `public/downloads/scorr.apk`
3. Builds Windows NSIS + Linux `.deb` + AppImage → `public/downloads/` + updater feeds under `/downloads/desktop/`
4. Writes `/downloads/version.json`, `build-meta.json`, `latest.yml` / `latest-linux.yml`
5. Deploys `dist` to Vercel (loads `VERCEL_TOKEN` from `.env` / `.env.local`, else Vercel CLI `auth.json`)
6. Optionally triggers Codemagic if `CODEMAGIC_*` env vars are set

### Vercel token (required for `deploy:site` / release deploy)

`.env` does **not** currently ship a `VERCEL_TOKEN`. If deploy fails with “token … is not valid”:

1. Open https://vercel.com/account/tokens → **Create** (Full Account, or the **walfia** team).
2. Put it in `.env` (uncommented, no quotes required):

   ```bash
   VERCEL_TOKEN=vercel_xxxxxxxx
   ```

3. Re-run: `npm run deploy:site`

Alternative: `npx vercel login` (browser). `deploy-site.mjs` will read the CLI token from `~/.local/share/com.vercel.cli/auth.json`.

## Android

- **Permanent release keystore** (never debug for production). Signing via env / `~/.scorr/keystore.env`.
- Backup path for the operator: **`~/Scorr-keystore-backup/`**
- In-app updater checks `https://scorr.walfia.ai/downloads/version.json` on start + daily; downloads APK and opens the system installer (`REQUEST_INSTALL_PACKAGES` + FileProvider). Login, Remember me, settings, and attendance enrollment survive package replacement.
- **Key change / first release-signed APK:** anyone still on a **debug-signed** build must uninstall once, then install the release APK. After that, updates install over the old app forever (same key). The in-app banner notes this when `notes` say so.
- Play Store later: same keystore, upload AAB (`bundleRelease`), enable Play App Signing.

## Windows

- NSIS installer + **electron-updater** (generic feed `…/downloads/desktop/`).
- Checks on start and every **6 hours**; background download; notification **Restart to update**.
- Login / attendance tokens live in Electron userData (not wiped on update).

## Linux

- **AppImage** uses electron-updater (same feed, `latest-linux.yml`).
- **`.deb`** shows in-app “Update available” + Download (apt channel optional later).

## iOS

| Channel | How updates ship |
| --- | --- |
| Home Screen / PWA | Vercel web deploy + Refresh banner |
| Native Capacitor 1.3.7+ | TestFlight / App Store; in-app `version.json` → store link |

### Distribution pros / cons

| Method | Pros | Cons |
| --- | --- | --- |
| PWA / Home Screen | Instant, no Apple review | Limited background location vs native |
| TestFlight | Fast internal/external beta | 90-day builds, Apple account |
| App Store | Public, trusted updates | Review delay, yearly fee |
| Ad-hoc / Enterprise | Direct IPA | Device UDIDs or Enterprise license |

### Exact Apple steps (operator)

1. Enroll in [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr).
2. App Store Connect → **My Apps** → **+** → bundle id `ai.walfia.scorr`, name **Scorr**.
3. Certificates: create **Apple Distribution** + **App Store** provisioning profile (or let Xcode / Codemagic manage).
4. Cloud build (pick one):
   - **Codemagic:** connect repo, macOS workflow, `ios` scheme, upload to TestFlight.
   - **Xcode Cloud:** Xcode → Product → Xcode Cloud → workflow on `main`.
5. Archive → upload → TestFlight internal group → external beta (Beta App Review) → App Store submission.
6. Set `SCORR_IOS_STORE_URL` to the App Store / TestFlight URL so `version.json` `ios.storeUrl` deep-links from in-app “Install update”.

No Mac on this CI host = ship source + docs; IPA comes from Codemagic/Xcode Cloud.

## `version.json`

Published at `https://scorr.walfia.ai/downloads/version.json`:

```json
{
  "webBuildId": "1.3.7-…",
  "mandatory": false,
  "android": { "versionName": "1.3.7", "versionCode": 13, "apkUrl": "…", "minSupportedCode": 1 },
  "windows": { "version": "1.3.7", "setupUrl": "…", "latestYmlUrl": "…" },
  "linux": { "version": "1.3.7", "debUrl": "…", "appImageUrl": "…" },
  "ios": { "version": "1.3.7", "pwaUrl": "…", "storeUrl": null }
}
```

`mandatory: true` (env `SCORR_UPDATE_MANDATORY=1`) blocks dismiss until the user updates.

## Settings → About

Shows app version, web build id, **Check for updates**. Admin device list marks **Outdated** when `app_version` is behind the live manifest.

## Staging → production

1. Deploy / smoke on staging (`npm run build` + staging URL or preview deploy).
2. Install current production client → publish higher `versionCode` / `webBuildId` → confirm Refresh / Install / Restart flows; credentials + enrollment survive.
3. `npm run release` (or push `main` for web-only) for production.

## Rollback

```bash
# Web: promote previous Vercel deployment
npx vercel rollback --token "$VERCEL_TOKEN"

# Or redeploy a known-good git SHA
git revert HEAD && git push origin main

# Android/desktop: restore previous artifacts into public/downloads/,
# rewrite version.json to the prior versionCode/version, redeploy.
```
