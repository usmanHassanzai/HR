# Attendance / office / auto-attendance rules reset — DONE

**Date:** 2026-10-12  
**Version bumped to:** **1.3.20** (Android versionCode **27**, iOS build **23**)

## Removed / paused

- Live SQL rule engines (Wi‑Fi/GPS match, windows, cron tick `scorr-attendance-cron`, guard triggers, silence/laptop/5b/5c handlers, …)
- Edge stubs: `auto-attendance-event`, `register-attendance-device`, `attendance-schedule` → `rules_not_configured`
- RPC stubs: `process_geo_*`, `process_auto_*`, check-in/out, schedule, setup status, **register device (no insert)**
- Client auto paths: SilentGeo, GeoTracker, native ping start, iOS Home pings, desktop `sendEvent`, Android FGS `onStartCommand` stops immediately
- 56 rule migrations moved to `supabase/migrations_archive/`; `attendance_rules_reset_2026-10-12.sql` is LAST in apply-all

## Stubs kept (UI still calls)

`process_geo_attendance_ping`, `process_auto_attendance_event`, `check_in/out_attendance`, `get_my_location_window`, `get_my_attendance_schedule`, `attendance_schedule_by_token`, `get_auto_attendance_setup_status`, `register_attendance_device`, `revoke_attendance_device` (no-op), `test_office_wifi_match`, settings update_* (save values only), `upsert_office_location` (save only, no pin sync)

## NOT touched (data kept)

| Table | Count (before = after) |
|-------|------------------------:|
| attendance_records | 47 |
| visit_segments | 70 |
| work_shifts | 7 |
| assignments | 20 |
| offices | 4 |
| networks | 9 |
| devices | 15 |

Also kept: leave, KPIs, rewards, departments, login/MFA, RLS, history RPCs, shift CRUD UI, office Create/Assign/All offices screens.

## Platforms needing a new build to stop background services

| Platform | Why |
|----------|-----|
| **Android** | Old APK still runs FGS until **1.3.20** / versionCode **27** installed |
| **iOS** | Old build still monitors regions until build **23** |
| **Desktop** | Old Electron still attempts heartbeats until **1.3.20** desktop publish (server/edge already stubs) |
| **Web** | Needs `npm run deploy:site` (and deploy edge functions) |

Edge functions must be redeployed to Supabase for the stub bodies to go live on the gateway (DB RPCs already stubbed).

## Backup / restore

- Counts: `backups/attendance_rules_reset_counts_before_2026-10-12.json`
- Data JSON: `backups/attendance_rules_reset_pre_2026-10-12.json` (PII — do not commit)
- Restore data: reload from that JSON / prior `pg_dump` if you made one
- Restore old rules: re-run archived migrations from `supabase/migrations_archive/` (not recommended) or restore function defs from `backups/fn_*.sql`

## Verify

- `npx tsc -b` ✅  
- `npm run build` ✅  
- Stubs return `rules_not_configured` ✅  
- Counts identical ✅  
