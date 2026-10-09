# STEP 0 — Rollback plan to Scorr 1.3.8 (report only)

**Date:** 2026-10-10  
**Project:** Scorr / walfia.ai (`yvnbxweitelowucdhwpg`)  
**Status:** Survey/plan only. **No code, migration, config, or data changes were made.**  
**Scope note:** This document does **not** continue `docs/attendance_investigation_2026-10-09.md`.

---

## 1) Version 1.3.8 baseline commit

### Finding: no git commit ever recorded `package.json` version `1.3.8`

Searched:

- `git log --all --grep=1.3.8`
- `git log -S '1.3.8'` on version files
- Every historical `package.json` / `version.json` / Android `versionName` / iOS `MARKETING_VERSION` / desktop `package.json`
- Dangling/unreachable commits

**Unique versions in git history skip 1.3.8:**  
`… → 1.3.6 → 1.3.7 → 1.3.9 → 1.3.10 → 1.3.12 → 1.3.15 → … → 1.3.19`

### What “1.3.8” was in practice

| Evidence | Detail |
|---|---|
| GitHub release | [`desktop-v1.3.8`](https://github.com/usmanHassanzai/HR/releases/tag/desktop-v1.3.8) published **2026-10-07T19:05:57Z**, target `main`, name “Scorr Desktop 1.3.8” |
| Agent history | Release chat ran `npm run release -- --bump-patch` (1.3.7→1.3.8) and deployed; version bump was **not** committed before the next “deployee” commit jumped to **1.3.9** |
| Last commit still versioned **1.3.7** | below |

### Adopted baseline (practical 1.3.8 tree)

| Field | Value |
|---|---|
| **Hash** | `52f8774869fac9fa388c4a4d4f72052168f82494` |
| **Short** | `52f8774` |
| **Date** | 2026-10-07 20:41:56 +0500 |
| **Message** | `updating the scorr landing page and pdf guide` |
| **Recorded versions at that commit** | package / desktop / Android / iOS all still **1.3.7** (`versionCode` **13**, iOS build **11**) |
| **Why this hash** | Last commit **before** `738bdde` (2026-10-08 06:08 +0500) which sets version **1.3.9** and lands the post-1.3.8 migration/UI wave. Desktop 1.3.8 was published between these two commits from an uncommitted bump. |

**Alias for this report:** “1.3.8 baseline” = commit `52f8774` (tree content), even though files still say 1.3.7.

Closest named ship commit before that: `9a22d14` — *Ship 1.3.7 auto-updates…* (same migration list end as `52f8774` for attendance).

---

### Every commit AFTER `52f8774` (17 commits), grouped

Grouping is by **paths touched** (a commit can appear in multiple groups).

#### Attendance (15)
| Hash | Date | Message |
|---|---|---|
| `738bdde` | 2026-10-08 | deployee all the changes |
| `5c563d9` | 2026-10-08 | deployee all the changes |
| `d84262f` | 2026-10-09 | deployee all the changes |
| `ba1cb84` | 2026-10-09 | Fix Vercel build: include checkin_blocked_shift_ended in GeoPingResult. |
| `17a9fc5` | 2026-10-09 | Attendance rules 1-7 |
| `13d80a5` … `6fb2130` | 2026-10-09/10 | deployee all the changes (multiple) |
| `c7e9ffa` | 2026-10-10 | Backup before rollback to 1.3.8 |

#### Shifts (4)
`738bdde`, `d84262f`, `ba1cb84`, `c7e9ffa` (shift helpers / upsert / duration)

#### Office (5)
`738bdde`, `5c563d9`, `d84262f`, `79f149e` (*Restore Wi-Fi + radius check-in gates…*), `c8ba7af`

#### Devices
No commit exclusively about MFA/trusted-device product after baseline.  
`FIX_register_attendance_device_upsert_2026-10-07.sql` lands in `738bdde` (attendance device RPC). Device **client** enrollment/ping code rides inside attendance commits.

#### KPI (2)
`738bdde`, `d84262f` — includes `allow_assign_kpi_to_hr_2026-10-08.sql`, `FIX_kpi_approve_hide_weightage_until_month_end_2026-10-09.sql`, KPI UI/CSS helpers

#### Rewards
**None** after baseline.

#### Other (non-attendance-only or mixed shell)
| Hash | Date | Message | Notes |
|---|---|---|---|
| `eab90ca` | 2026-10-09 | Refresh build-meta and desktop latest.yml for production release. | release manifests only |
| `79f149e` | 2026-10-09 | Restore Wi-Fi + radius check-in gates… | office/check-in gates |
| Many `deployee` commits | 2026-10-08…10 | version bumps, Android/iOS/desktop, landing, delete-account, remembered login, etc. | bundled with attendance |

---

### NON-attendance changes that would be **lost** by rolling files back to `52f8774`

These are the meaningful product losses beyond “revert attendance rules”:

1. **KPI — assign to HR** (`allow_assign_kpi_to_hr_2026-10-08.sql` + related UI): org admins/HR can assign KPI tasks to HR users.
2. **KPI — month-end weightage notice** (`FIX_kpi_approve_hide_weightage_until_month_end_2026-10-09.sql`): approval copy hides awarded weightage until month end; cron job `scorr-kpi-weightage-month-end` (`notify_month_end_kpi_weightage`).
3. **Leave policy on company** (`FIX_company_leave_allowance_2026-10-08.sql`): `companies.annual_leave_days` / `sick_leave_days` + `ensure_leave_balance` / get/set policy RPCs; leave panel UI tweaks.
4. **Office radius single-source UX** (`office_radius_single_source_2026-10-09.sql` + `OfficeLocationSettings.tsx`): `office_version`, sync triggers to work sites — **office product**, not only attendance ping logic.
5. **Shift management UX** changes tied to `FIX_shift_add_member_on_save`, `FIX_per_user_shift_hours`, `FIX_shift_times_drive_attendance`, richer `upsert_work_shift` overloads.
6. **App update / version plumbing** after 1.3.8: `write-version-json.mjs`, `vite.config.ts` webBuildId persistence, `AboutUpdatesPanel` / `AppUpdateBanner`, desktop publish URL wiring.
7. **Account / security / delete-account** UI scripts touched after baseline (`DeleteAccount*`, `AccountSecurityPanel`, `deploy-delete-account.mjs`, remembered login).
8. **Landing / portal polish** bundled in deploy commits (LandingPage, dashboards CSS, session guard).
9. **All post-1.3.8 version bumps** (1.3.9…1.3.19) and their native build numbers — replaced in STEP 2 by **1.3.14** with higher codes (see §5).

**Rewards:** nothing to lose after baseline.  
**Demo seed “Morning Shift”** and older MFA migrations already existed at baseline — not lost by this rollback.

---

## 2) Migrations added/changed after 1.3.8 baseline

### Cross-check: `scripts/apply-all-migrations.mjs` vs `supabase/migrations/`

At baseline `52f8774`, the apply list **ended** at:

`attendance_auto_tests.sql`

At HEAD, **48** migrations are listed **after** `attendance_auto_tests.sql` (all attendance/office/KPI-leave related except as noted).

Also inserted **before** that end marker after baseline:

| File | First seen | Role |
|---|---|---|
| `FIX_register_attendance_device_upsert_2026-10-07.sql` | `738bdde` | device register upsert fix |

Present on disk but **not** in apply-all LAST list (ignore for apply order; do not treat as live apply):

- `ROLLBACK_attendance_auto_NOT_APPLIED.sql`
- `ROLLBACK_trusted_devices_mfa_NOT_APPLIED.sql`

`fix_pgcrypto_extensions_search_path_2026-10-07.sql` was **modified** after baseline (small search_path tweak).

`trusted_devices_mfa*.sql` already in apply list **at baseline** — not post-1.3.8.

### Post-baseline migrations in apply-all order (48) → objects

Abbreviated object map (full pattern scan of each file):

| Migration | Creates / changes |
|---|---|
| `FIX_visit_out_before_in_stale_close_2026-10-08.sql` | fn `trg_attendance_visit_out_after_in`, `attendance_close_stale_presence`, `get_my_attendance_visits`; trigger on visits |
| `allow_assign_kpi_to_hr_2026-10-08.sql` | fn `can_assign_kpi_to` |
| `FIX_history_same_clock_in_out_2026-10-08.sql` | `attendance_resolve_history_clock_out`, `get_attendance_history`, `get_team_attendance_history` |
| `FIX_r69_wifi_gps_immediate_checkout_2026-10-08.sql` | `attendance_now`, `process_auto_attendance_event`, `attendance_close_stale_presence`; col `attendance_devices.gps_outside_streak` |
| `FIX_shift_end_checkout_no_late_checkin_2026-10-08.sql` | check-in/end helpers; trigger `trg_attendance_block_checkin_after_shift_end`; cron `scorr-attendance-cron` |
| `FIX_shift_end_timezone_orphan_visits_2026-10-08.sql` | `app_timezone`, `shift_end_timestamptz`, history/close helpers |
| `FIX_history_open_visit_still_present_2026-10-08.sql` | history clock-out resolution |
| `FIX_office_radius_exact_checkout_2026-10-08.sql` | `geo_confirm_left_site`, auto/geo RPCs |
| `FIX_auto_attendance_priority_2026-10-08.sql` | auto priority over manual |
| `FIX_midshift_auto_checkin_enrolled_2026-10-08.sql` | geo/auto mid-shift check-in |
| `FIX_shift_mobile_desktop_clocks_2026-10-08.sql` | dual-clock window helpers |
| `FIX_desktop_test_now_status_2026-10-08.sql` | `process_auto_attendance_event` |
| `FIX_zero_length_shift_duration_2026-10-08.sql` | `close_open_attendance_if_shift_ended` |
| `FIX_laptop_office_ip_without_bssid_2026-10-08.sql` | `attendance_match_office_wifi` |
| `FIX_no_checkout_while_in_office_2026-10-08.sql` | auto/geo + office network helpers |
| `FIX_stay_present_office_history_2026-10-08.sql` | history still-open helpers |
| `FIX_checkout_only_outside_not_on_wifi_2026-10-08.sql` | stale-close / network |
| `FIX_company_leave_allowance_2026-10-08.sql` | leave policy fns; cols `companies.annual_leave_days`, `sick_leave_days` |
| `FIX_shift_add_member_on_save_2026-10-09.sql` | `shift_close_other_assignments` |
| `FIX_checkin_requires_office_wifi_2026-10-09.sql` | Wi-Fi gate helpers |
| `FIX_checkin_radius_and_wifi_2026-10-09.sql` | GPS+Wi-Fi check-in |
| `FIX_checkout_one_outside_reading_2026-10-09.sql` | `geo_confirm_left_site` |
| `FIX_checkout_outside_no_exceptions_2026-10-09.sql` | office network helper |
| `FIX_kpi_approve_hide_weightage_until_month_end_2026-10-09.sql` | `notify_month_end_kpi_weightage`; cron `scorr-kpi-weightage-month-end` |
| `FIX_checkout_outside_immediate_permanent_2026-10-09.sql` | (comments / re-apply markers) |
| `FIX_checkin_require_wifi_and_radius_no_bypass_2026-10-09.sql` | `check_in_attendance` |
| `FIX_shift_times_drive_attendance_2026-10-09.sql` | `upsert_work_shift`, window/display zone sync |
| `FIX_per_user_shift_hours_2026-10-09.sql` | per-user shift hours |
| `FIX_checkin_wifi_and_radius_restore_2026-10-09.sql` | restore gates after overwrite |
| `attendance_rule_6_2026-10-09.sql` | Rule 6 helpers |
| `attendance_rule_1_7_2026-10-09.sql` | Rules 1+7 presence |
| `attendance_rule_2_overnight_early_2026-10-09.sql` | overnight early window |
| `attendance_cleanup_2026-10-09.sql` | `attendance_retention_cleanup`, rewrite `attendance_cron_tick`; **drop** several helpers; tables `attendance_events_log_archive`, `employee_location_pings_archive`; cron `scorr-attendance-retention` |
| `attendance_immediate_inout_2026-10-09.sql` | immediate in/out |
| `attendance_device_signal_realtime_2026-10-09.sql` | realtime publication grants |
| `attendance_checkin_wifi_no_gps_2026-10-09.sql` | Wi-Fi-only check-in |
| `office_radius_single_source_2026-10-09.sql` | office sync fns/triggers; col `office_locations.office_version` |
| `attendance_manual_checkout_wifi_no_gps_2026-10-09.sql` | manual checkout Wi-Fi path |
| `FIX_manual_checkout_v_chk_unassigned_2026-10-09.sql` | checkout bugfix |
| `attendance_rules_5b_5c_2026-10-09.sql` | Rules 5b/5c fns; company/user signal cols; trigger on `attendance_events_log` |
| `attendance_ios_silence_rule5_2026-10-09.sql` | iOS silence; col `companies.ios_office_signal_timeout` |
| `attendance_laptop_rules_2026-10-09.sql` | laptop L-rules; sleep/off-office cols |
| `attendance_ios_home_location_2026-10-09.sql` | iOS home location settings assert |
| `attendance_false_checkout_fix_2026-10-09.sql` | false-checkout helpers; visit merge cols; audit `visit_id` |
| `attendance_reentry_tracking_2026-10-09.sql` | `attendance_try_auto_checkin` |
| `attendance_zero_minute_loop_fix_2026-10-09.sql` | suppression table `attendance_auto_close_suppressed` |
| `attendance_app_close_not_leave_2026-10-10.sql` | app background/quit handlers; `attendance_backgrounded_minutes`, `last_app_backgrounded_at` |
| `attendance_shift_duration_sum_2026-10-10.sql` | duration sum helpers; history/visits RPCs |
| (+ mid-list) `FIX_register_attendance_device_upsert_2026-10-07.sql` | `register_attendance_device` |

---

## 3) Function / trigger / cron: baseline vs live

Live catalog read via Management API `database/query` + `pg_get_functiondef` / `cron.job` (SELECT only). Baseline bodies taken from **last `CREATE OR REPLACE` in apply order at `52f8774`** via `git show 52f8774:supabase/migrations/…`.

### Cron jobs

| Job | Baseline (`attendance_cron.sql` at 1.3.8) | Live now | Diff |
|---|---|---|---|
| `scorr-attendance-cron` | `*/5 * * * *` → `attendance_cron_tick()` | `*/2 * * * *` → `attendance_cron_tick();` | **schedule 5→2 min**; tick body changed (below) |
| `scorr-attendance-retention` | **did not exist** | `20 3 * * *` → `attendance_retention_cleanup()` | **post-1.3.8 only** |
| `scorr-kpi-weightage-month-end` | **did not exist** | `20 * * * *` → `notify_month_end_kpi_weightage()` | **post-1.3.8 only** |
| `scorr-kpi-performance-awards` | (pre-existing awards cron) | `15 1 1 * *` → `evaluate_kpi_awards_all_companies()` | keep (not introduced after 1.3.8) |

### `attendance_cron_tick` body diff (critical)

**1.3.8 (repo):**

```sql
-- close ended windows + stale presence + (ping cleanup in same migration era)
v_ended := public.attendance_close_ended_windows();
v_stale := public.attendance_close_stale_presence();
-- returns closed_ended / closed_stale / …
```

**Live now:**

```sql
v_ended := public.attendance_close_ended_windows();
v_lap   := public.attendance_apply_laptop_rules();
v_5c    := public.attendance_apply_rule_5c();
v_5b    := public.attendance_apply_rule_5b();
v_retention := public.attendance_retention_cleanup();
-- returns closed_ended / closed_laptop / closed_offline_5c / closed_no_office_wifi_5b / retention
```

### Key functions — presence and size (md5 of live `pg_get_functiondef`)

| Function | At 1.3.8 repo | Live | Diff verdict |
|---|---|---|---|
| `process_auto_attendance_event` | `attendance_auto_rpc.sql` ~19k chunk | len **24303** md5 `e8b0f0f44d08…` | **CHANGED** (rules 5b/5c/laptop/app_quit/etc.) |
| `process_geo_attendance_ping` | `attendance_geo_window.sql` ~11k | 3 overloads, lens ~15–17k | **CHANGED** (+ overloads) |
| `attendance_close_stale_presence` | real closer ~2.6k | **stub returning 0** len 346 | **CHANGED** (neutered by cleanup) |
| `attendance_cron_tick` | ended+stale | laptop+5b+5c+retention | **CHANGED** |
| `check_in_attendance` | writers_window | len 3800 | **CHANGED** (Wi-Fi+radius gates) |
| `check_out_attendance` | 1-arg | 1-arg + geo overload | **CHANGED** / **overload added** |
| `get_attendance_history` / `get_team_attendance_history` | baseline history | duration-sum aware | **CHANGED** |
| `get_my_attendance_visits` | overnight migration | duration-sum | **CHANGED** |
| `close_open_attendance_if_shift_ended` | writers_window | len 5693 | **CHANGED** |
| `geo_confirm_left_site` | writers_window | len 434 | **CHANGED** (exact radius / one reading) |
| `attendance_window_for_user` | window_core | len 5657 | **CHANGED** |
| `register_attendance_device` | pgcrypto fix | len 2415 (+ upsert fix live) | **CHANGED** slightly |
| `upsert_work_shift` | hr_shift_permissions | 2 overloads live | **CHANGED** / overload |
| `can_assign_kpi_to` | dept scope | HR assign allowed | **CHANGED** |
| `attendance_apply_rule_5b/5c` | **absent** | present | **LIVE ONLY** |
| `attendance_apply_laptop_rules` | **absent** | present | **LIVE ONLY** |
| `attendance_retention_cleanup` | **absent** | present | **LIVE ONLY** |
| `attendance_try_auto_checkin` | **absent** | present | **LIVE ONLY** |
| `attendance_handle_*` (sleep/wake/shutdown/connection_lost/app_*) | **absent** | present | **LIVE ONLY** |
| `notify_month_end_kpi_weightage` | **absent** | present | **LIVE ONLY** |
| `sync_work_sites_to_office` | older sync migration | rewritten + triggers | **CHANGED** |

### Live triggers (attendance/office) not in 1.3.8 form

| Trigger | Table | Post-1.3.8? |
|---|---|---|
| `trg_attendance_events_log_touch_signals` | `attendance_events_log` | yes (5b/5c) |
| `trg_attendance_block_checkin_after_shift_end` | `attendance_records` | yes |
| `trg_attendance_present_requires_presence_evidence` | `attendance_records` | yes (rules 1/7 era) |
| `trg_office_locations_bump_version` / `_after_sync` | `office_locations` | yes (single-source) |
| Window guards / session minutes / visit out-after-in | records/visits | mixed (some pre-existed; visit out-after-in reworked) |

**Byte-identical def dumps** for STEP 4 should re-apply baseline migration SQL then `md5(pg_get_functiondef(...))` vs `git show`-extracted expected bodies — live ≠ baseline for every heavily edited RPC above (no zero-diff today).

---

## 4) Data after 1.3.8 (SELECT only — nothing deleted)

Cutoff used: desktop 1.3.8 publish time **2026-10-07 19:05:57 UTC** / attendance_date ≥ 2026-10-07.

### Counts

| Dataset | Count | Notes |
|---|---|---|
| `attendance_records` total | **55** | |
| Records with `created_at` ≥ cutoff | **18** | |
| Real-user records (excl `@scorr.test`, qa@scorr, test@test.com) | **53** | |
| `attendance_visit_segments` total | **101** | |
| Visits with `clock_in_at` ≥ cutoff | **60** | almost all real users |
| Real-user visits | **100** | |
| `attendance_events_log` total / since cutoff | **271** / **263** | |
| `attendance_devices` | **18** | |
| `attendance_auto_close_suppressed` | **0** | safe to drop empty table later |
| `attendance_events_log_archive` | **0** | |
| `employee_location_pings_archive` | **89** | retention archive — keep (not test) |

### Devices by `app_version` (update path constraint)

| app_version | n | Platforms seen |
|---|---|---|
| **1.3.7** | 15 | android/ios/windows/linux |
| **1.3.12** | 2 | android (recent: Anees, Nasir) |
| **1.3.9** | 1 | android test EdgeIP |

**HEAD native codes today:** Android `versionCode` **25** / iOS build **21**.  
**1.3.14 ship must use Android versionCode ≥ 26 and iOS `CURRENT_PROJECT_VERSION` ≥ 22** so 1.3.7/1.3.9/1.3.12 clients can update.

### Proven test / QA leftovers (candidates for STEP 3 delete list — **plan only**)

| Kind | Identity | Provenance | Attendance impact |
|---|---|---|---|
| Company | `EdgeIP 0f9f49a4` (`edge-ip-0f9f49a4`) | `scripts/test-edge-attendance-ip.mjs` leftover | 0 att / 0 visits |
| Users | `admin_edge_0f9f49a4@scorr.test`, `emp_edge_0f9f49a4@scorr.test` | same script | 1 device on emp |
| Shift | `EdgeIP Shift` | same | 1 assignment |
| Company | `Scorr QA` + users `qa@scorr.walfia.ai`, `qa2@scorr.walfia.ai` | QA/smoke (manual/external) | **2** QA attendance rows |
| Shifts | `QA Day`, `Prod Smoke Day`, `Prod Smoke One Zone` | QA smoke | little/no real att |
| Company/user | `Test` / `test@test.com` | old (2026-09-11) | treat cautiously; **pre-1.3.8** |
| Shift | `Morning Shift` | demo seed `shift_attendance.sql` | demo Jim — **not** post-1.3.8 test junk |

**Do NOT treat as test:** AC Shift, night shift, Day, real Arrant users, real visits with notes like “GPS entry Arrant Construction”, “Closed (shift ended)”, “Device offline…” (those are **real** auto-rule artifacts on real people — keep rows).

### Columns/tables new since 1.3.8 that hold real data

Keep tables/columns (do not DROP in STEP 3):

- Signal/timeout cols on `companies` / `users` (5b/5c/laptop/background) — may be populated for real users  
- `attendance_devices.gps_outside_streak`, `presence_state`  
- `office_locations.office_version`  
- `companies.annual_leave_days`, `sick_leave_days` if admins saved values  
- Visit merge/audit cols; archives with 89 ping rows  

1.3.8 code can **ignore** extra columns; STEP 3 restores functions that do not require dropping them.

---

## 5) Rollback plan (exact order) — **DO NOT RUN until user says go**

### STEP 1 — Backup (after go)

```bash
mkdir -p /home/usman/walfia.ai/backups
# Prefer Supabase CLI or pg_dump with DB URL from dashboard; example shape:
pg_dump "$DATABASE_URL" \
  --format=plain --no-owner --no-privileges \
  --schema=public --schema=cron \
  -t 'public.attendance_*' -t 'public.employee_location_pings*' \
  -t 'public.office_*' -t 'public.work_shifts' \
  -t 'public.employee_shift_assignments' -t 'public.companies' -t 'public.users' \
  -f /home/usman/walfia.ai/backups/rollback_2026-10-10.sql

# Also dump function defs snapshot:
# SELECT proname, pg_get_functiondef(oid) … > backups/rollback_2026-10-10_funcs.sql
```

Do **not** commit the dump if it contains PII. Tell operator the absolute path.

### STEP 2 — Code branch to 1.3.8 tree + ship as 1.3.14

```bash
cd /home/usman/walfia.ai
git fetch origin
git checkout -b rollback-1.3.8

# Restore product tree to baseline (keeps branch history; no force-push):
git checkout 52f8774 -- .

# Re-apply / keep testing rule if present on current tip (file missing today — see caveat):
git checkout HEAD -- .cursor/rules/testing.mdc 2>/dev/null || true
# If still missing: recreate from team rule before merge (user asked to keep it).

# Set marketing version 1.3.14 EVERYWHERE (package.json, desktop/package.json,
# android versionName, ios MARKETING_VERSION, electron-builder if needed).
# Android versionCode: 26 or higher (must exceed 25).
# iOS CURRENT_PROJECT_VERSION: 22 or higher (must exceed 21).

# Trim scripts/apply-all-migrations.mjs:
#   - Remove every migration after attendance_auto_tests.sql
#   - Remove FIX_register_attendance_device_upsert_2026-10-07.sql from mid-list
#   - APPEND new rollback SQL as LAST entry (STEP 3 file)
```

**Caveat:** `.cursor/rules/testing.mdc` is **not present** in the workspace now (0 matches). STEP 2 must not delete it if it appears on the branch tip; if absent, restore from wherever the team keeps it before merge.

### STEP 3 — One re-runnable DB migration (LAST)

Create `supabase/migrations/rollback_to_1_3_8_2026-10-10.sql` and list it **last** in apply-all.

Contents (design):

1. **Unschedule** post-1.3.8 crons: `scorr-attendance-retention`, `scorr-kpi-weightage-month-end`.  
2. **Reschedule** `scorr-attendance-cron` to `*/5 * * * *` calling `attendance_cron_tick()`.  
3. **Recreate** 1.3.8 function/trigger bodies by embedding (or `\i`-equivalent concatenated) the baseline definitions from:
   - `attendance_auto_rpc.sql`
   - `attendance_cron.sql` (full closer + tick)
   - `attendance_geo_window.sql`
   - `attendance_writers_window.sql`
   - `attendance_window_core.sql`
   - history/visits/shift RPCs as of `52f8774` last writers  
   - `can_assign_kpi_to` from `kpi_assign_dept_scope.sql` (reverts HR assign)  
   - leave helpers from pre-`FIX_company_leave_allowance` if needed for UI compatibility  
4. **DROP FUNCTION** post-only helpers that 1.3.8 does not call (safe examples once no deps):  
   `attendance_apply_rule_5b/5c`, `attendance_apply_laptop_rules`, `attendance_handle_*`, `attendance_retention_cleanup`, `attendance_try_auto_checkin` (if unused by restored RPCs), `notify_month_end_kpi_weightage`, list/gap admin helpers, etc.  
   Drop in dependency order; use `CASCADE` only where catalog proves no real app RPC remains.  
5. **DROP TRIGGER** post-only: `trg_attendance_events_log_touch_signals`, office version sync triggers if 1.3.8 UI/SQL restored without them — only if restored code paths do not require them.  
6. **Do NOT DROP** tables/columns with real data (`attendance_*`, signal cols, `office_version`, leave cols, archives). Empty `attendance_auto_close_suppressed` may be dropped optionally.  
7. **Test data removal** — only after printing a SELECT list; proposed deletes:

```sql
-- PLAN ONLY preview (run SELECT first in STEP 3 execution):
-- EdgeIP company d939f70d-… + @scorr.test users + EdgeIP Shift + their devices
-- Optionally QA smoke shifts with 0 real-org assignments
-- DO NOT delete AC Shift / night shift / Day / real Arrant attendance
```

8. Migration must be **re-runnable** (`CREATE OR REPLACE`, `DROP IF EXISTS`, cron unschedule/schedule guards).

### STEP 4 — Verify

```bash
npx tsc -b
npm run build

# Live def check (read-only): for each restored function,
# md5(pg_get_functiondef) == md5(expected from migration text / 52f8774 extract)
# Expect zero diff after STEP 3.

# Counts:
# attendance_records / visits unchanged except listed test deletes
# Report: 0 test rows left (EdgeIP/@scorr.test gone if deleted)
```

### Post-merge operator commands (after STEP 4 success — for FINISH later)

```bash
git push -u origin rollback-1.3.8
# PR → review → merge (no force push)

npm run release   # or platform-specific:
# Android: versionName 1.3.14, versionCode >= 26
# Desktop: electron-builder 1.3.14 + publish
# iOS: MARKETING_VERSION 1.3.14, CURRENT_PROJECT_VERSION >= 22
```

---

## Risks / decisions for the user before “go”

1. **Baseline hash confirmation:** Proceed with `52f8774` as 1.3.8 tree? (No commit literally tagged 1.3.8.)  
2. **KPI/leave/office single-source losses** listed in §1 — confirm acceptable.  
3. **Test deletes:** EdgeIP only vs also QA smoke tenants.  
4. **Real visits created under new rules** stay in DB (correct) but may look “wrong” under restored 1.3.8 logic going forward.  
5. **`testing.mdc` missing** — provide source or accept recreate.  
6. Unfinished attendance investigation doc remains untouched.

---

## Live access note

Production SELECTs via Supabase Management API **succeeded** (function defs, cron, counts, devices). No INSERT/UPDATE/DELETE/DDL was run.

---

STEP 0 COMPLETE — WAITING FOR GO  
NO CHANGES MADE

---

## STEP 1–4 execution record (2026-10-10)

**Branch:** `rollback-1.3.8` @ `72dd014`  
**Baseline restored:** `52f8774`  
**Ship version:** 1.3.14 (Android versionCode **26**, iOS build **22**)

| Step | Result |
|---|---|
| 1 Backup | Logical dump (Management API; no DB password for pg_dump) at `/home/usman/walfia.ai/backups/rollback_2026-10-10.sql` (~801KB, **PII — not committed**) |
| 2 Code | Tree restored to 52f8774; post-1.3.8 files removed; `testing.mdc` created; apply-all ends with `attendance_auto_tests` + `rollback_to_1_3_8_2026-10-10.sql` |
| 3 DB | Migration applied live; cron `scorr-attendance-cron` = `*/5`; retention + KPI weightage crons removed; 5b/5c/laptop helpers dropped; 1.3.8 RPC bodies restored |
| 4 Verify | `npx tsc -b` pass; `npm run build` pass; attendance_records **55**, visits **101** unchanged; devices 18→17; **0** `@scorr.test` users |

**Test data removed:** EdgeIP company `edge-ip-0f9f49a4`, users `admin_edge_*/emp_edge_*@scorr.test`, shift `EdgeIP Shift`, 1 android device, related events.

