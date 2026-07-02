# Scorr — scorr.walfia.ai

HR KPI & rewards platform (React + Vite + Supabase).

## Quick start

```bash
npm install
node scripts/setup-db.mjs      # first time / DB reset
npm run dev                    # http://localhost:5173
```

## Demo logins

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@walfia.ai | admin123 |
| Manager | manager@walfia.ai | manager123 |
| Employee | employee@walfia.ai | employee123 |

## Roles

- **Employee** — view KPI tasks, mark complete, rewards, change password
- **Manager** — team performance, **KPI Config** (assign tasks), team rewards
- **Admin** — users, reports, analytics, branding, rewards catalog

## KPI workflow

1. Manager assigns KPI: employee, department, description, start/end dates
2. Employee gets notification + email (when configured)
3. Employee clicks **Mark Complete** → manager notified + email
4. Missed deadline → alert; 3 misses → **−300 points**

## Email (Resend)

1. Add to `.env`: `RESEND_API_KEY=re_...`
2. Run: `node scripts/deploy-kpi-email.mjs`
3. Later: verify **scorr.walfia.ai** in Resend, set `KPI_EMAIL_FROM=Scorr <noreply@scorr.walfia.ai>`, redeploy

Until domain is verified, Resend only sends to your signup email.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup-db.mjs` | Full DB reset + seed |
| `scripts/kpi-task-migration.mjs` | KPI task columns + RPCs |
| `scripts/deploy-kpi-email.mjs` | Deploy email edge function + secrets |
| `scripts/backfill-kpi-dates.mjs` | Add dates to existing KPIs (no reset) |

## Build & deploy (scorr.walfia.ai)

```bash
node scripts/deploy-production.mjs   # configures Supabase auth + builds dist/
```

### Mobile apps (Android APK + iOS)

See **[MOBILE.md](./MOBILE.md)** for full instructions.

```bash
node scripts/build-android-apk.mjs   # builds APK → public/downloads/scorr.apk
npm run build                        # copies APK into dist/ for deploy
npx vercel --prod --yes              # deploy website + download link
```

Or one command before deploy:

```bash
npm run prepare:deploy && npx vercel --prod --yes
```

### Vercel (recommended)

1. [vercel.com](https://vercel.com) → Import this repo (or `vercel link` in project folder)
2. **Environment variables** (Production):
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
3. Deploy → **Settings → Domains** → add `scorr.walfia.ai`
4. At your DNS host for **walfia.ai**:
   - **CNAME** `scorr` → `cname.vercel-dns.com`
5. Optional: redirect `walfia.ai` → `scorr.walfia.ai` in Vercel or Cloudflare

Or with CLI after `vercel login`:
```bash
VERCEL_TOKEN=your_token node scripts/deploy-production.mjs
```

### VPS (nginx)

Upload `dist/` to server, use `deploy/nginx-scorr.conf`, point `scorr.walfia.ai` A record to server IP.

## Features

- KPI tasks with deadlines, completion, redo penalties
- Points & rewards (employee + manager)
- Monthly/quarterly PDF/Excel/CSV reports
- Custom branding, PWA, Capacitor mobile-ready
- Password change + admin reset
