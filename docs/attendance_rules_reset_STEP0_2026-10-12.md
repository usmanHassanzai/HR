# Attendance / shift RULE LOGIC reset — STEP 0 inventory

**Date:** 2026-10-12 (Asia/Karachi)  
**Mode:** Report only. No drops, no stubs, no client edits until **"go"**.  
**Goal after go:** Remove rule logic only. Keep UI, routes, tables, and all existing rows. Stubs return `rules_not_configured` and never write attendance.

**Live row counts (baseline before any STEP 1):**

| Table | Count |
|-------|------:|
| attendance_records | 47 |
| attendance_visit_segments | 70 |
| work_shifts | 7 |
| employee_shift_assignments | 20 |
| office_locations | 4 |
| office_wifi_networks | 9 |
| attendance_devices | 15 |

---

## 1. Exact backup commands (run before STEP 1)

Prefer classic `pg_dump` if `DATABASE_URL` / DB password is available. Otherwise use the Management API logical dump (as used for prior rollbacks).

### Option A — `pg_dump` (preferred)

```bash
cd /home/usman/walfia.ai
mkdir -p backups
export PGPASSWORD='…'   # from Supabase project DB settings
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="backups/attendance_rules_reset_pre_$(date +%Y-%m-%d).dump" \
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
  --table=public.manager_work_sites
```

Schema-only backup of rule functions (optional):

```bash
pg_dump "$DATABASE_URL" --schema-only --file="backups/attendance_rules_schema_$(date +%Y-%m-%d).sql" \
  --table=public.attendance_records \
  --table=public.attendance_visit_segments
# Plus: save pg_get_functiondef for all attendance_* / process_geo_* / process_auto_* beforehand via Management API.
```

### Option B — Management API logical dump (no DB password)

```bash
cd /home/usman/walfia.ai
mkdir -p backups
# Use existing scripts pattern / node + SUPABASE_PAT to SELECT * INTO JSON/SQL for the tables above
# Output: backups/attendance_rules_reset_pre_2026-10-12.sql  (do not commit if PII)
```

**Do not commit** dumps that contain personal data. Tell the operator the path after STEP 1.

---

## 2. Database objects — keep / remove / stub

Legend:
- **REMOVE** — drop (rule engine)
- **STUB** — keep signature the UI/edge calls; body returns `rules_not_configured` (or empty read-safe payload); **no writes**
- **KEEP** — not rule logic (CRUD, history read, device register, leave, RLS protect)

### 2.1 Cron jobs

| Job | Schedule | Command | Decision | Why |
|-----|----------|---------|----------|-----|
| `scorr-attendance-cron` | `*/2 * * * *` | `attendance_cron_tick()` | **REMOVE** | Shift-end / silence / stale close engine |
| `scorr-attendance-retention` | `20 3 * * *` | `attendance_retention_cleanup()` | **KEEP** (or pause) | Retention ≠ check-in rules; recommend keep unless you want zero attendance cron |
| `scorr-kpi-*` | … | KPI | **KEEP** | Not attendance rules |

### 2.2 Triggers (rule guards)

| Table | Trigger | Decision | Why |
|-------|---------|----------|-----|
| attendance_records | `trg_attendance_block_checkin_after_shift_end` | **REMOVE** | Blocks check-in after shift end |
| attendance_records | `trg_attendance_records_window_guard` | **REMOVE** | Window guard on clock times |
| attendance_records | `trg_attendance_use_session_minutes` | **KEEP** (data integrity) or neutralize | Session minutes helper — not a check-in allow rule; prefer keep if it only recomputes minutes |
| attendance_visit_segments | `trg_attendance_visits_window_guard` | **REMOVE** | Window guard |
| attendance_visit_segments | `trg_attendance_visit_out_after_in` | **KEEP** | Integrity (out ≥ in), not policy rules |

### 2.3 Functions — must STUB (UI / edge still call)

These must remain callable so pages do not 404/500. Bodies must **not** create/update attendance rows.

| Function | Callers | Decision |
|----------|---------|----------|
| `process_geo_attendance_ping(...)` (all overloads) | `src/utils/geoAttendance.ts`, GeoAttendancePanel | **STUB** → `{ action/status: rules_not_configured }` |
| `process_auto_attendance_event(...)` | `supabase/functions/auto-attendance-event` | **STUB** → `rules_not_configured` |
| `check_in_attendance(date)` | AttendanceLeavePanel (if still used) | **STUB** |
| `check_out_attendance(date)` / GPS overload | AttendanceLeavePanel | **STUB** |
| `get_my_location_window()` | GeoAttendancePanel, usePortalSessionGuard | **STUB** empty / `rules_not_configured` (read-only OK if shift display only — prefer stub flag) |
| `get_my_attendance_schedule()` | attendanceDevice, attendance-schedule edge | **STUB** empty schedule + status |
| `attendance_schedule_by_token(hash)` | attendance-schedule edge | **STUB** |
| `close_my_ended_shift_attendance()` | presenceHeartbeat | **STUB** no-op |
| `close_open_attendance_if_shift_ended(...)` | cron / writers | **REMOVE** (no cron) or stub no-op |
| `get_today_geo_attendance()` | geo UI if used | **STUB** / keep read |
| `get_auto_attendance_setup_status()` | AutoAttendanceSetupWizard | **STUB** paused messaging |
| `geo_confirm_left_site(...)` | geo path | **REMOVE** or unused after stub |

### 2.4 Functions — REMOVE (pure rule logic; not required as stubs)

Examples (live inventory; drop in reset migration):

- `attendance_cron_tick`, `attendance_close_ended_windows`, `attendance_apply_rule_5b`, `attendance_apply_rule_5c`, `attendance_apply_laptop_rules`
- `attendance_window_for_user`, `attendance_checkin_allowed`, `attendance_bounds_for_clock`
- `attendance_match_office_wifi`, `attendance_on_assigned_office_wifi`, `attendance_gps_inside_assigned_office`, `attendance_ip_in_cidrs`
- `attendance_try_auto_checkin`, `attendance_ensure_open_visit` (writer), `attendance_close_visit_with_note`, `attendance_backfill_closed_visit`
- `attendance_handle_connection_lost`, `attendance_handle_device_sleep/wake/shutdown`, laptop/iOS silence helpers
- `attendance_block_checkin_after_shift_end`, `attendance_guard_clock_times`, `attendance_present_requires_presence_evidence`
- `attendance_effective_*_signal_at`, `attendance_raw_office_signal_at`, touch-signal helpers if present
- `is_within_shift_window`, `is_within_shift_exit_window` (SQL) — rule windows
- `reconcile_ended_shift_attendance`

### 2.5 Functions — KEEP (not rule decisions)

| Area | Examples | Why |
|------|----------|-----|
| History / summary | `get_attendance_history`, `get_team_attendance_history`, `get_my_attendance_summary`, `get_my_attendance_visits`, `attendance_day_total_minutes`, `attendance_history_work_minutes` | Display existing data |
| Shifts CRUD | `upsert_work_shift`, `delete_work_shift`, `get_manager_shifts`, `admin_assign_shift`, `assign_employee_shift`, `get_my_shift`, `get_user_assigned_shift`, `list_shift_display_zones` | Keep shift UI |
| Offices / Wi‑Fi CRUD | `list_office_wifi_networks`, `replace_office_wifi_networks`, `get_my_work_site`, `get_work_site_for_user`, `assign_*_work_site`, `sync_work_sites_to_office` | Keep office data/UI (matching rules go away) |
| Devices | `register_attendance_device`, `revoke_attendance_device`, `list_company_attendance_devices*` | Keep enrollment |
| Leave / mark / review | `mark_attendance`, `review_attendance`, leave RPCs | Keep leave |
| Admin correction | `correct_attendance_times` | Keep (admin tool; optional stub later if desired) |
| Utils | `haversine_meters`, `app_timezone`, `attendance_hash_device_token`, `can_manage_org_shifts` | Shared helpers |

### 2.6 RLS policies

| Decision | Why |
|----------|-----|
| **KEEP** all `attendance_*` / `work_shifts` / `office_*` RLS | Protect data; not check-in rules |

### 2.7 Enums

| Type | Decision | Why |
|------|----------|-----|
| `attendance_status` | **KEEP** | Data labels present/absent/late/half_day |
| `attendance_source` (text values) | **KEEP** | Historical source strings on rows |

---

## 3. Client / UI — encode rules (edit after go)

| File | Role | After go |
|------|------|----------|
| `src/utils/geoAttendance.ts` | Calls `process_geo_*`; maps reason codes | Keep call; show paused / `rules_not_configured` |
| `src/utils/shiftHelpers.ts` | Local window / exit window gates | Remove rule gates; keep display formatters |
| `src/components/GeoAttendancePanel.tsx` | Manual Clock in/out + old Wi‑Fi/radius copy | Keep buttons; banner: *Attendance rules are being rebuilt…* |
| `src/components/GeoAttendanceTracker.tsx` | Auto geo ping | Pause / no-op auto |
| `src/components/SilentGeoAttendance.tsx` | Arms native background | Pause / no-op rule sends |
| `src/components/AttendanceLeavePanel.tsx` | check_in / check_out RPCs | Keep UI; stub message |
| `src/components/AutoAttendanceSetupWizard.tsx` | Setup copy describing old rules | Rewrite text (no old Wi‑Fi/GPS/window rules) |
| `src/utils/autoAttendanceSetup.ts` | Setup status / register | Keep register; status from stub |
| `src/utils/attendanceDevice.ts` | Schedule + auto events | Stop treating schedule as allow-gate |
| `src/utils/attendanceStaleQueue.ts` | 10‑min stale drop tied to old rules | Soften / pause |
| `src/utils/attendanceAppBackgrounded.ts` | Lifecycle events | Pause or send only if stub accepts |
| `src/utils/usePortalSessionGuard.ts` | location window gate | Remove attendance rule gate |
| `src/utils/presenceHeartbeat.ts` | `close_my_ended_shift_attendance` | No-op OK via stub |
| `src/components/OfficeLocationSettings.tsx` | Check-in uses Wi‑Fi+GPS text | Soften copy (CRUD stays) |
| `src/components/LandingPage.tsx` | Marketing shift/Wi‑Fi rules | Soften (optional) |
| Android `AttendancePingService` / `ScheduleController` / `EventClient` / Geofence* | Local radius/Wi‑Fi/window | Remove local allow decisions; still can collect signals later |
| iOS `AttendancePingPlugin.swift` | Geofence / schedule | Same |
| `desktop/main.cjs` | Network / sleep events + rule messages | Pause auto; keep shell |

**UI must keep calling** (stubs): `process_geo_attendance_ping`, `process_auto_attendance_event`, `check_in_attendance`, `check_out_attendance`, `get_my_location_window`, `get_my_attendance_schedule`, `get_auto_attendance_setup_status`, `register_attendance_device`, history/visits/shift getters.

---

## 4. Migrations & `apply-all-migrations.mjs`

### How deploy runs them

`npm run deploy:live` → `scripts/deploy-live.mjs` → **`node scripts/apply-all-migrations.mjs`** (every file in `MIGRATIONS` in order, swallows errors) → build → Vercel.

### Rule-heavy segment (must archive so deploy cannot recreate rules)

From `scripts/apply-all-migrations.mjs` (approx lines 198–252), including:

- Core: `attendance_tz_shift_fields`, `attendance_window_core`, `attendance_settings`, `office_network_allowlist`, `attendance_source_enum`, `attendance_devices`, `attendance_events_log`, `attendance_enforcement_triggers`, `attendance_auto_rpc`, `attendance_register_device_rpc`, `attendance_correction_rpc`, `attendance_schedule_rpc`, `attendance_cron`, `attendance_writers_window`, `attendance_geo_window`, `attendance_leave_window`, `attendance_rls_lockdown`, `office_network_upsert`, `attendance_auto_tests`
- Earlier rule writers also in list: `geo_auto_attendance_restore`, `auto_checkout_when_shift_ends`, `gps_only_attendance_checkout`, `shift_one_hour_edges`, `multi_visit_shift_checkin`, `mid_shift_checkout`, `shift_entry_exit_location`, …
- All `FIX_*` attendance/checkin/checkout/wifi/radius/shift-end patches (Oct 8–9)
- `attendance_rule_6_*`, `attendance_rule_1_7_*`, `attendance_rule_2_*`, `attendance_cleanup_*`, `attendance_immediate_inout_*`

**STEP 1 plan:** move those files to `supabase/migrations_archive/`, remove from `MIGRATIONS`, add **last** `attendance_rules_reset_2026-10-12.sql` that drops rule objects + installs stubs. Keep table-creating migrations that only create columns/tables **or** ensure reset never drops tables.

**Careful:** Some early files (`shift_attendance.sql`, `attendance_devices.sql`) create tables — **archive rule *bodies*** but keep table DDL already applied live; do not drop tables. Reset migration must not `DROP TABLE`.

---

## 5. STEP 1 preview (after your "go" only)

1. Run backup commands (§1); record counts.
2. One migration `attendance_rules_reset_2026-10-12.sql` (LAST): drop rule triggers/cron/functions; stub UI RPCs; GRANT execute; `NOTIFY pgrst`.
3. Archive old rule migrations; trim `apply-all-migrations.mjs`.
4. Client: pause auto; banner text; wizard copy; remove local window/Wi‑Fi/radius allow decisions.
5. Tests: pages load; stubs `rules_not_configured`; no new attendance rows; counts unchanged; `npx tsc -b`; `npm run build`; dry `apply-all` does not recreate old rules.

---

## STEP 0 COMPLETE — WAITING FOR GO

NO CHANGES MADE
