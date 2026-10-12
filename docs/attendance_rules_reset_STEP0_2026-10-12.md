# Attendance + shift + office + auto-attendance SETTINGS reset — STEP 0

**Date:** 2026-10-12 (Asia/Karachi)  
**Mode:** Report only. No drops, stubs, or client edits until **"go"**.  
**Goal after go:** Strip all rule + auto-attendance *decision* logic. Keep UI, routes, tables, stored switch values, and all rows. Stubs return `rules_not_configured`. No new attendance rows, no new device registrations. Office CRUD and settings toggles still *save values only*.

**Current app version in tree:** `1.3.10` (Android `versionCode` 16, iOS build 11).  
**STEP 1 will bump** version so new native builds replace old background services.

**Live row counts (baseline):**

| Table | Count |
|-------|------:|
| attendance_records | 47 |
| attendance_visit_segments | 70 |
| work_shifts | 7 |
| employee_shift_assignments | 20 |
| office_locations | 4 |
| office_wifi_networks | 9 |
| manager_work_sites | 4 |
| attendance_devices | 15 |

Stored switches (KEEP values): `companies.auto_phone_attendance`, `companies.auto_laptop_attendance`, `users.auto_phone_attendance`, `users.auto_laptop_attendance`, plus related minute/threshold columns on companies (not used as rules after reset).

---

## 1. Exact backup commands

```bash
cd /home/usman/walfia.ai
mkdir -p backups
export PGPASSWORD='…'   # Supabase DB password
STAMP=$(date +%Y-%m-%d)

pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="backups/attendance_full_rules_reset_pre_${STAMP}.dump" \
  --table=public.attendance_records \
  --table=public.attendance_visit_segments \
  --table=public.attendance_devices \
  --table=public.attendance_events_log \
  --table=public.attendance_corrections_audit \
  --table=public.attendance_monthly_reports \
  --table=public.work_shifts \
  --table=public.employee_shift_assignments \
  --table=public.shift_display_zones \
  --table=public.office_locations \
  --table=public.office_wifi_networks \
  --table=public.manager_work_sites \
  --table=public.companies \
  --table=public.users

# Optional: function defs snapshot via Management API →
# backups/attendance_full_rules_funcs_pre_${STAMP}.sql
```

**Restore:**

```bash
pg_restore --clean --if-exists --no-owner \
  -d "$DATABASE_URL" \
  backups/attendance_full_rules_reset_pre_YYYY-MM-DD.dump
```

Do not commit dumps with PII.

---

## 2. Inventory — keep / remove / stub / strip

### 2.1 Cron

| Job | Decision | Why |
|-----|----------|-----|
| `scorr-attendance-cron` | **REMOVE** | Rule engine tick |
| `scorr-attendance-retention` | **KEEP** | Retention ≠ rules |
| KPI crons | **KEEP** | Unrelated |

### 2.2 Triggers

| Object | Decision | Why |
|--------|----------|-----|
| `trg_attendance_block_checkin_after_shift_end` | **REMOVE** | Rule |
| `trg_attendance_records_window_guard` | **REMOVE** | Rule |
| `trg_attendance_visits_window_guard` | **REMOVE** | Rule |
| `trg_attendance_use_session_minutes` | **KEEP** | Integrity |
| `trg_attendance_visit_out_after_in` | **KEEP** | Integrity |
| `trg_office_locations_after_sync` | **REMOVE** | Pin/radius propagation rule |
| `trg_office_locations_bump_version` / bump_and_sync | **STRIP** | Drop sync side-effect; optional version bump only |
| `trg_office_locations_validate_network` | **REMOVE** | Duplicate-IP validation |
| `trg_office_wifi_networks_normalize` | **KEEP** | Hygiene |
| `trg_office_wifi_networks_sync_agg` | **KEEP** | Storage denorm for UI |

### 2.3 Edge functions

| Edge | Decision | Why |
|------|----------|-----|
| `supabase/functions/auto-attendance-event` | **STUB body** | UI/native still POST; return `{ ok:false, status/reason: rules_not_configured }`; no RPC write |
| `attendance-schedule` | **STUB** empty schedule + status | Still called for setup/clients |
| `register-attendance-device` | **STUB** no insert | Must not register devices |
| `_shared/trustedClientIp.ts` | **KEEP** | Shared util |
| `trusted_device` | **KEEP** | MFA, not attendance |

### 2.4 SQL — STUB (UI still calls; no attendance write; no device register)

| Function | Callers | Stub |
|----------|---------|------|
| `process_geo_attendance_ping` (*) | geoAttendance / GeoAttendancePanel | `rules_not_configured` |
| `process_auto_attendance_event` | edge (after edge stub may not call) | same |
| `check_in_attendance` / `check_out_attendance` | AttendanceLeavePanel | same |
| `get_my_location_window` | Geo panel, portal guard | empty + status |
| `get_my_attendance_schedule` / `attendance_schedule_by_token` | device + edge | empty + status |
| `get_auto_attendance_setup_status` | wizard | paused / rules_not_configured |
| `register_attendance_device` | wizard / edge | **STUB — no insert, no auto_* flip** |
| `revoke_attendance_device` | AutoAttendanceSettings | **STUB or keep revoke-only?** User: register nothing; revoke can stay as data op or stub with message — prefer **STUB** returning rules_not_configured so nothing changes device set during rebuild |
| `close_my_ended_shift_attendance` | presenceHeartbeat | no-op |
| `test_office_wifi_match` | OfficeLocationSettings | rules_not_configured |
| `send_auto_attendance_setup_reminder` | settings | stub / no-op message |

### 2.5 SQL — REMOVE (rule / auto decision engines)

Attendance/shift: `attendance_cron_tick`, close_ended, rule 5b/5c, laptop rules, `attendance_window_for_user`, `attendance_checkin_allowed`, try_auto_checkin, ensure_open_visit, close_visit_with_note, connection_lost/device_* handlers, guard/block triggers’ functions, signal stamps, `is_within_shift_*`, reconcile_ended, `geo_confirm_left_site`, …

Office match: `attendance_match_office_wifi`, `attendance_on_assigned_office_wifi`, `attendance_gps_inside_assigned_office`, `is_within_office`, presence check if recreated, …

Auto as *input to rules*: any remaining code paths that branch on `auto_phone_attendance` / `auto_laptop_attendance` inside process_* (gone with stubs).

### 2.6 SQL — KEEP store / STRIP rule (settings + office)

| Function | Decision |
|----------|----------|
| `update_company_auto_attendance(phone, laptop, tz)` | **STRIP** — UPDATE companies columns only; no enablement side effects |
| `update_user_auto_attendance(user, phone, laptop)` | **STRIP** — UPDATE users columns only |
| `upsert_office_location` | **STRIP** — save fields; no sync_work_sites rule path |
| `replace_office_wifi_networks` / delete / list | **KEEP** store |
| `update_office_default_timezones` | **KEEP** |
| `assign_*_work_site` / `assign_office_to_all_*` / remove / getters | **KEEP** store |
| `sync_work_sites_to_office` | **NO-OP or REMOVE call sites** |
| `delete_office_location` | **KEEP** |
| History / shift CRUD / leave / mark / review / correction | **KEEP** |
| `haversine_meters` | **KEEP** (display math) |
| All data RLS policies | **KEEP** |
| Enums `attendance_status` / source text | **KEEP** |

### 2.7 Policies / enums

RLS on attendance/office/shift/devices — **KEEP**.  
`attendance_status` enum — **KEEP**.

---

## 3. Client files & UI text

| File | Decision after go |
|------|-------------------|
| `GeoAttendancePanel.tsx` | Banner: *Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.* Buttons stay; show message; no successful clock |
| `GeoAttendanceTracker.tsx` | **Stop** pings |
| `SilentGeoAttendance.tsx` | **Stop** arming native/background |
| `AttendanceLeavePanel.tsx` | Manual in/out → stub message |
| `AutoAttendanceSetupWizard.tsx` | Steps visible; no register; no old rule copy (account ready / computer / office network / device) |
| `autoAttendanceSetup.ts` | No registerDevice; permission/battery steps show paused message |
| `AutoAttendanceSettings.tsx` | Toggles still call update_* (save values); revoke/remind → stub; list devices read-only OK |
| `OfficeLocationSettings.tsx` | CRUD saves; strip rule prose; Test Wi‑Fi → stub |
| `shiftHelpers.ts` | Remove allow gates |
| `attendanceDevice.ts` / stale queue / app_backgrounded / native ping | Stop schedule gates & auto event sends (or send only to stub) |
| `usePortalSessionGuard.ts` | Remove location-window attendance gate |
| `presenceHeartbeat.ts` | close_my → stub no-op |
| Android `AttendancePingService`, Geofence*, Schedule*, BootReceiver, WindowReceiver, EventClient | **Disable FGS / geofence / Wi‑Fi / boot restart / alarms** in new build |
| iOS `AttendancePingPlugin.swift` | **Disable** region + significant location |
| `desktop/main.cjs` | **Disable** auto-launch attendance runner, tray heartbeat, network-change sends |
| Landing marketing copy | Soften (optional) |

---

## 4. Office save vs settings save (store vs rule)

### Store only → KEEP (strip side effects)

- `upsert_office_location`, wifi replace/list/delete, timezone update, assign/remove, getters, delete office  
- `update_company_auto_attendance`, `update_user_auto_attendance` — **persist booleans/timezone only**

### Rule / enrollment logic → REMOVE or STUB

- Match/presence/GPS/Wi‑Fi functions; validate_network; sync_work_sites propagation  
- `register_attendance_device` (today also flips user auto_* true) → stub, no row, no flip  
- `process_*` using company/user auto_* as allow gates → stubs  
- Wizard eligibility / battery / permission *as gates* → UI message only  

---

## 5. Migrations & apply-all

`deploy:live` → `apply-all-migrations.mjs` runs the full `MIGRATIONS` list in order.

**Archive** rule recreators into `supabase/migrations_archive/` and remove from the list, including:

- Attendance window/auto/cron/writers/geo/leave/enforcement + `geo_auto_*` + shift edge/mid/multi visit + all `FIX_*` checkin/checkout/wifi/radius/office/stale/laptop/shift-end  
- `attendance_rule_*`, `attendance_cleanup_*`, `attendance_immediate_inout_*`  
- Office: `office_network_allowlist` (validation), matcher-heavy wifi migrations’ matchers (CRUD already live), `sync_office_live_pin_to_assignments`  
- Device register migrations that implement real register (`attendance_register_device_rpc`, `FIX_register_attendance_device_upsert_*`) — archived; stub provided by reset  

**LAST:** `attendance_rules_reset_2026-10-12.sql` (re-runnable).

Do **not** `DROP TABLE`. Do **not** clear `auto_*` columns or device rows.

---

## 6. Old native builds vs new builds

| Platform | After server reset (old APK/IPA/desktop still installed) | New build must |
|----------|-----------------------------------------------------------|----------------|
| **Android** | FGS / geofence / Wi‑Fi / boot receivers may still run and POST events; edge/RPC stubs → no check-in; battery drain continues until update | Stop service, geofence, listeners, boot/update/swipe restart, alarms; bump `versionCode` > 16 |
| **iOS** | Region / SLC may still wake and POST → stub only | Disable monitoring; bump build > 11 |
| **Desktop** | Tray/heartbeat/network events may still POST → stub | Disable auto runner; bump desktop version |
| **Web** | Immediate on deploy of new JS | Tracker/Silent off; banner |

**Bump plan (STEP 1):** e.g. ship **1.3.20** (or next unused) with Android `versionCode` ≥ 27 and iOS build ≥ 23 so devices that sat on 1.3.7–1.3.14 also update.

---

## 7. STEP 1 preview (after "go")

1. Backup §1; snapshot counts.  
2. One LAST migration: drop rule triggers/cron/functions; stub UI RPCs + register; strip office/settings saves; edge stub file for `auto-attendance-event` (+ schedule/register edges).  
3. Archive migrations; trim apply-all.  
4. Clients: pause everything; banner text; wizard/settings/office copy; disable native background in source; bump version.  
5. Tests: pages load; office save works; toggles save; stubs + edge `rules_not_configured`; no new attendance/device rows; counts unchanged; `tsc` + `build`; apply-all does not recreate rules.

---

## STEP 0 COMPLETE — WAITING FOR GO

NO CHANGES MADE
