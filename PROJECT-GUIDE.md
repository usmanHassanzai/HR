# Scorr — Project Guide

**Live app:** https://scorr.walfia.ai  
**Repo:** https://github.com/usmanHassanzai/HR  
**Stack:** React 19 + Vite + TypeScript + Supabase  

---

## What Scorr Does

Scorr is an HR KPI and rewards platform. Three roles:

| Role | Can do |
|------|--------|
| **Admin** | Manage users, reports, analytics, branding, rewards catalog, run monthly points job |
| **Manager** | Assign KPIs, view team leaderboard, approve reward redemptions, own KPIs/points |
| **Employee** | View KPIs, mark complete before deadline, earn/redeem points |

**Core flow:** Manager assigns KPI tasks → Employee completes before deadline → Monthly score → Points → Redeem rewards → Manager approves.

---

## Architecture (Simple)

```
User browser
    ↓
scorr.walfia.ai  (Vercel — hosts the React app)
    ↓
Supabase (auth + PostgreSQL + edge functions)
    ↓
Resend (sends KPI emails from noreply@scorr.walfia.ai)
```

**Local only:** `.env` file with keys (never committed to GitHub).

---

## Domain Setup

| Item | Value |
|------|--------|
| **Main brand domain** | `walfia.ai` (owned on GoDaddy) |
| **App subdomain** | `scorr.walfia.ai` (where Scorr runs) |
| **Why subdomain?** | Keeps `walfia.ai` free for a company site later; matches app branding and email |

**DNS record (GoDaddy):**
- Type: **CNAME**
- Name: `scorr`
- Points to: `cname.vercel-dns.com`

**Vercel:** Project `hr` → Settings → Domains → added `scorr.walfia.ai`

---

## Why Each Service?

### Vercel — Hosting
- Hosts the built React app (`npm run build` → `dist/`)
- Free tier, auto-deploy from GitHub, free SSL
- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

### GoDaddy — DNS
- You bought/manage `walfia.ai` there
- DNS records live here (the CNAME that points `scorr` to Vercel)
- GoDaddy does **not** host the app — only routes traffic

### who.is — Lookup tool (not part of the stack)
- Used once to **check** who controls `walfia.ai` DNS (showed GoDaddy nameservers)
- Not required for production — just diagnostic

### Resend — Email
- Sends transactional emails (KPI overdue, completed, etc.)
- From: `noreply@scorr.walfia.ai` (domain verified in Resend)
- Runs via Supabase edge function `kpi_email` — **not** in the React app
- Key stays in Supabase secrets, not Vercel

### Supabase — Backend
- **Auth:** login (email/password)
- **Database:** users, KPIs, tasks, notifications, points, rewards
- **Edge functions:** email, reports, etc.
- **Site URL:** `https://scorr.walfia.ai`

---

## Rewards Rules (Current)

Monthly KPI score → points (never expire):

| Score | Points |
|-------|--------|
| ≥ 90% | 1,000 |
| 80–89% | 500 |
| 70–79% | 250 |
| < 70% | 0 |

- Catalog rewards cost **1,000 points** each
- **−300 points** if employee misses 3 KPI deadlines
- Admin runs **Monthly Points Job** (Admin → Rewards → Run Now)

---

## Demo Logins

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@walfia.ai | admin123 |
| Manager | manager@walfia.ai | manager123 |
| Employee | employee@walfia.ai | employee123 |

---

## Key Folders

| Path | Purpose |
|------|---------|
| `src/components/` | Dashboards, login, rewards UI |
| `src/lib/supabase.ts` | Supabase client |
| `supabase/schema.sql` | Database schema + RPCs |
| `supabase/functions/` | Edge functions (email, etc.) |
| `scripts/` | DB setup, deploy, migrations |
| `vercel.json` | Vercel routing config |

---

## Deploy Checklist

1. Push code → GitHub → Vercel auto-builds
2. Vercel env vars set (Supabase URL + anon key)
3. GoDaddy CNAME: `scorr` → `cname.vercel-dns.com`
4. Supabase auth URL = `https://scorr.walfia.ai`
5. Resend domain verified for `scorr.walfia.ai`

---

## Useful Commands

```bash
npm run dev                          # Local dev server
npm run build                        # Production build
node scripts/setup-db.mjs            # Reset DB (local/dev)
node scripts/update-rewards-tiers.mjs # Apply rewards SQL to live DB
node scripts/deploy-kpi-email.mjs    # Deploy email function + Resend secret
```

---

*Scorr — scorr.walfia.ai · Walfia*
