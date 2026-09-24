# Scorr — Project Guide

**Live app:** https://scorr.walfia.ai  
**Stack:** React + Vite + TypeScript + Supabase + Capacitor  

---

## What Scorr Does

Scorr is a company workspace for KPIs, GPS attendance, and weightage-based rewards.

| Role | Can do |
|------|--------|
| **Admin** | People, departments, assign KPIs, rewards catalog/history, attendance, Office GPS, live tracking, analytics, export, branding |
| **Manager** | Assign team KPIs, team attendance/leave, approve/reject gifts, own KPIs & redeem |
| **Employee** | My KPIs, attendance/leave, redeem gifts (Current or Banked) |
| **HR** | Shifts and rewards support |

**Core flow:** Assign KPI → Complete before deadline → Monthly weightage → Redeem gift → Manager/Admin approves, rejects, or fulfills.

### KPI assignment

- Department KPI library may list many metrics.
- Per person: pending/active weights cannot exceed **100%**.
- Assign Task: department → person → KPI(s) → dates → Assign.

### Rewards (current)

Rewards use **weightage (0–100%)**, not a separate points wallet.

| Term | Meaning |
|------|---------|
| **Earned** | This month’s completed KPI weightage |
| **Current** | Still available this month |
| **Used** | Gift cost this month (never above Earned) |
| **Banked** | Leftover after monthly gifts, summed across months |

- **One monthly gift** per month (dinner **or** catalog).
- Cost = gift requirement only; leftover Current → **Banked**.
- **Redeem with Banked** when Banked covers the cost.
- **Streak gifts:** movie 90–95% × 3 months; surprise 90–95% × 6 months (no weightage spend).
- **Reject** refunds weightage.

### Login errors

- Registered email, wrong password → “Incorrect password.”
- Unknown email → “Incorrect email and password.”

---

## Architecture

```
Browser / Android / iOS PWA
    ↓
scorr.walfia.ai  (Vercel)
    ↓
Supabase (Auth + PostgreSQL + Edge Functions)
    ↓
Resend (noreply@scorr.walfia.ai)
```

Local secrets live in `.env` (never commit).

---

## Useful Commands

```bash
npm run dev                          # Local web
npm run build                        # Production web build
npm run build:android:apk            # APK → public/downloads/scorr.apk
npm run docs:client-guide            # PDF → public/downloads/Scorr-Client-Feature-Guide.pdf
node scripts/apply-all-migrations.mjs
```

---

## Client guide

User-facing PDF: `public/downloads/Scorr-Client-Feature-Guide.pdf`  
Regenerate: `npm run docs:client-guide`  
Linked from the landing page Mobile / Download section.

---

*Scorr — scorr.walfia.ai · Walfia*
