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

- `Scorr-Setup.exe` (Windows installer — Start Menu + Desktop shortcuts)
- `Scorr.deb` (Linux)

AppImage is no longer shipped.

These files are **too large for GitHub git and often too large for the Vercel
site upload**, so the landing page should download them from a **GitHub Release**:

```bash
gh auth login
npm run publish:desktop
```

Then set the printed `VITE_DESKTOP_*_URL` values in Vercel → Environment Variables
and redeploy the site.
