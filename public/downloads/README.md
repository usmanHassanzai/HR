# Public downloads

| File | Notes |
|------|--------|
| `scorr.apk` | **Primary Android install** until Google Play is live. Keep until **2026-11-01**, then delete. Play listing `ai.walfia.scorr` currently returns 404. |
| `Scorr-Windows.zip` | Windows desktop (Electron) — unzip and run `Scorr.exe`; same Sign In as `?app=1` |
| `Scorr.AppImage` | Linux desktop AppImage (Electron) |
| `Scorr.deb` | Linux .deb package (when built) |
| `Scorr-Client-Feature-Guide.pdf` | Client feature guide |
| `Scorr-Security-Overview.pdf` | Security overview for organizations |
| `build-info.json` | Build metadata for the download section |

Build desktop installers with `npm run build:desktop`.

When Play Store / App Store listings go live:

1. Set `PLAY_STORE_LIVE = true` in `src/utils/appStoreLinks.ts`
2. Set `VITE_APP_STORE_URL` to the App Store product page
3. After 2026-11-01, delete `scorr.apk` if no longer needed
