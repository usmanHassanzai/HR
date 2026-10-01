# Public downloads

| File | Notes |
|------|--------|
| `scorr.apk` | **Legacy sideload** — keep serving until **2026-11-01**, then delete this file and remove APK references from the site. Prefer Google Play: `https://play.google.com/store/apps/details?id=ai.walfia.scorr` |
| `Scorr-Client-Feature-Guide.pdf` | Client feature guide |
| `build-info.json` | Build metadata for the download section |

After 2026-11-01:

1. Delete `public/downloads/scorr.apk`
2. Remove APK exception lines from `.gitignore` / `.vercelignore` if desired
3. UI already hides the APK button via `APK_DIRECT_UNTIL` in `src/utils/appStoreLinks.ts`
