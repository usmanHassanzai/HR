# Attendance rollout plan (1.3.6)

**Rule:** nothing is applied, deployed, pushed, or published without an explicit `apply` / `deploy` for that specific item.

Production project: `yvnbxweitelowucdhwpg` (ap-northeast-1). Plan: **Free** — no downloadable daily backups, **PITR off**.

---

## Order of operations

### 0) Backup (done — refresh before any apply)

| Item | Value |
|------|--------|
| Location | `/home/usman/backups/scorr/` (outside repo) |
| Canonical dump | `scorr-prod-2026-10-06T16-31-22Z.pgdump` (1.1 MB, custom format) |
| Pooler host | `aws-1-ap-northeast-1.pooler.supabase.com` (**not** `aws-0`) |
| Notes | `/home/usman/backups/scorr/RESTORE.md` |

**Verify:** `pg_restore --list` on the `.pgdump` (see RESTORE.md).

**Rollback / restore into EMPTY project only:**
```bash
export PGPASSWORD='STAGING_OR_NEW_DB_PASSWORD'
docker run --rm --user "$(id -u):$(id -g)" -e PGPASSWORD \
  -v /home/usman/backups/scorr:/backups postgres:17-alpine \
  pg_restore --clean --if-exists --no-owner --no-acl \
  -d "postgresql://postgres.NEWREF@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres" \
  /backups/scorr-prod-2026-10-06T16-31-22Z.pgdump
```

**Staging project (created):** `utxylrrrzsjetncrajxj` (`scorr-staging`, ap-northeast-1).  
Use `.env.staging` locally. **Every migration: staging first → prod dry-run → explicit `apply`.**  
Free-tier note: `chaikhaata` was paused to free the 2-project slot.

**Recommendation:** upgrade to **Pro** for daily backups + a permanent staging slot without pausing other projects; add **PITR** if RPO matters.

---

### 1) Check-in realign fix — `FIX_check_in_realign_NOT_APPLIED.sql`

**Wait for:** `apply` (this item only).

**What it does:** `attendance_realign_shift_records` no-ops during `check_in` / `check_out` / `geo` / `auto` write modes so live check-in is not rejected as `attendance_outside_window`.

**Dry-run (already done):** `BEGIN` → apply SQL → check_out / check_in cycles as Abdul → all PASS → `ROLLBACK`. Live function unchanged (`def_len` 2453).

**Apply:** run the file once on production (Management API or SQL editor).

**Verify:**
- As a test user with an open visit: check out → check in → check out → check in succeeds (no `attendance_outside_window`).
- `pg_get_functiondef('public.attendance_realign_shift_records(uuid)'::regprocedure)` contains `attendance_write_mode() IN`.

**Rollback:** restore prior function body from backup `schema-catalog.json`, or re-apply the pre-fix definition (full historical realign). File: keep a copy of the old def before apply.

---

### 2) IP verification + edge redeploy — R73

**Platform proof (done):** temporary `debug-ip-echo` deployed, forged, deleted.

| Header | Result |
|--------|--------|
| `cf-connecting-ip` | Platform overwrites to real client IP. Forging → Cloudflare **1000 / 403**. **Trust.** |
| `x-real-ip` | Always null; forged value stripped. **Do not trust** (removed from helper). |
| `true-client-ip` / `x-client-ip` | Pass through forged. **Never trust.** |
| `x-forwarded-for` | Entirely rewritten. Form: `<client>,<client>, <aws-hop>`. Leftmost = client; rightmost = AWS. |

**Helper updated locally:** `supabase/functions/_shared/trustedClientIp.ts` — prefer `cf-connecting-ip`, else **leftmost** XFF. Not redeployed yet.

**Wait for:** `apply` / `deploy` for `auto-attendance-event` only.

**Verify after deploy:** office-SSID device event records `client_ip` = real public IP (not `13.248.*` AWS, not a forged leftmost).

**Rollback:** redeploy previous `auto-attendance-event` bundle (or revert helper to last known good and redeploy).

---

### 3) Section O migration — `shift_display_zones_NOT_APPLIED.sql`

**Wait for:** `apply` (this item only).

**Includes:** backfill `companies.timezone = Asia/Karachi` → `NOT NULL` → drop Karachi defaults → `shift_display_zones` → extended `upsert_work_shift` (old clients OK) → `handle_new_user` requires timezone → attendance_date identity check.

**Dry-run (already done):** all steps PASS; `ROLLBACK`; prod unchanged (`shift_display_zones` absent).

**Verify after apply:**
```sql
SELECT count(*) FROM companies WHERE timezone IS NULL OR btrim(timezone) = '';  -- 0
SELECT count(*) FROM information_schema.tables WHERE table_name = 'shift_display_zones'; -- 1
-- Old client save still works (no p_timezone)
-- New UI save with display zones works
```

**Rollback:** `ROLLBACK_attendance_auto_NOT_APPLIED.sql` does **not** fully reverse Section O. Prefer restore from backup / staging replay. Manual reverse: drop `shift_display_zones`, restore prior `upsert_work_shift` / `app_timezone` / `handle_new_user` from schema catalog.

---

### 4) Web deploy

**Wait for:** `deploy` (web only).

Deploy the web app that includes R59 UI, Section O pickers, registration timezone required, after DB steps 1–3 are applied.

**Verify:** registration requires timezone; shift save with display zones; check-in/out on web for a pilot user.

**Rollback:** redeploy previous Vercel production deployment.

---

### 5) Pilot (1–2 test users)

1. Enroll 1–2 devices with auto-attendance.
2. Run `docs/attendance-device-checklist.md` on real devices (Android + desktop if available).
3. Confirm IP allowlist / SSID / geofence behaviour against production logs.

**Do not** enable company-wide until checklist is green.

**Rollback:** disable auto-attendance for pilot users / revoke device tokens; no schema rollback needed.

---

### 6) Publish 1.3.6 apps

Artifacts (local only until you say publish):

| Platform | Artifact | Notes |
|----------|----------|--------|
| Desktop Windows | `Scorr-Setup.exe` | Built into `/home/usman/releases/scorr/1.3.6/` — **not** in `public/downloads` |
| Desktop Linux | `Scorr.deb` | Same local release folder |
| Android | APK / Play | versionName `1.3.6`, versionCode `10` |
| iOS | IPA | Built on your Mac — MARKETING_VERSION `1.3.6`, build `10` |

**Wait for:** explicit `publish` / `deploy` for store / downloads.

**Verify:** installers report 1.3.6; attendance ping + background session on device.

**Rollback:** keep previous 1.3.5 installers; do not overwrite store listings until verified.

---

### 7) Enable for the whole team

1. Announce timezone / shift display behaviour.
2. Enable auto-attendance / enroll remaining devices.
3. Monitor first 2–3 shift windows for window errors and IP rejects.

**Rollback:** feature-flag / disable auto enrollment; leave DB migrations in place unless a critical defect requires restore.

---

## Quick checklist

- [ ] Fresh backup (or confirm current backup age is acceptable)
- [ ] `apply` FIX_check_in_realign → verify check-in cycles
- [ ] `deploy` auto-attendance-event (R73 helper) → verify client_ip
- [ ] `apply` Section O migration → verify no NULL company TZ + attendance_date unchanged
- [ ] `deploy` web → registration TZ + shift UI
- [ ] Pilot 1–2 users + device checklist
- [ ] Publish 1.3.6 apps after device OK
- [ ] Team-wide enable

---

## Related files

- `supabase/migrations/FIX_check_in_realign_NOT_APPLIED.sql`
- `supabase/migrations/shift_display_zones_NOT_APPLIED.sql`
- `supabase/functions/_shared/trustedClientIp.ts`
- `docs/attendance-device-checklist.md`
- `/home/usman/backups/scorr/RESTORE.md`
- `/home/usman/releases/scorr/1.3.6/` (desktop artifacts — local)
