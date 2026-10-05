# Scorr Desktop (Electron)

Thin desktop shell that opens the same Sign In screen as the mobile app
(`https://scorr.walfia.ai/?app=1`). Admin, HR, manager, and employee all use
this one installer — role dashboards appear after sign-in.

## Develop

```bash
# Against production
npm run desktop

# Against local Vite
SCORR_DESKTOP_URL=http://localhost:5173/?app=1 npm run desktop
```

## Build installers

```bash
npm run build:desktop
```

Artifacts land in `public/downloads/`:

- `Scorr-Windows.zip` (Windows — unzip, run Scorr.exe)
- `Scorr.AppImage` (Linux)
- `Scorr.deb` (Linux, when available)
