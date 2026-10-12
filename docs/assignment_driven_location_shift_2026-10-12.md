# Assignment-driven location + shift — 2026-10-12

Assigned **locations** and **shifts** drive presence and clock windows from data. No hardcoded countries, PK/US times, default offices, or special-case employee lists.

## What is data-driven now

| Concern | Source | Behavior |
| --- | --- | --- |
| Presence / radius | `employee_work_sites` → `office_locations` (pins + configured radius) | OR across **assigned** locations only. Manager team zone only if person has no personal rows. No org-wide office fallback. |
| Shift membership | `employee_shift_assignments` / apply-to-all via `get_active_shift_for_user` | Person must have an assigned (or apply-to-all) shift. |
| Clock window | That shift’s `work_shifts` times + `timezone`, plus equal rows in `shift_display_zones` | `get_my_location_window` / `attendance_window_for_user` OR across zones. No Asia/Karachi invent; no fake company hours when unassigned. |
| App / company TZ | `companies.timezone` → `app_timezone()` | Falls back to **UTC** only — never invents a country zone. |

## Hardcoding removed

- `app_timezone()` / `company_timezone()` no longer force `Asia/Karachi`.
- Column DEFAULTs for `companies.timezone` / `work_shifts.timezone` dropped (existing values kept).
- No company location-window fallback (17:30–04:00 etc.) when someone has no shift.
- Presence no longer invents a fixed 150 m radius; uses configured `office_locations.radius_meters`.
- UI office create copy no longer uses “Karachi HQ” as the example name.

## Remaining stubs (block writes)

These still do **not** write attendance / devices (by design until auto Wi‑Fi rules are rebuilt):

- `check_in_attendance` / `check_out_attendance` → no-op
- `process_auto_attendance_event` + edge `auto-attendance-event` / `register-attendance-device` / `attendance-schedule`
- Full Wi‑Fi match / silence / laptop rule engines

**Presence reads** and **shift window reads** work after this migration. Clock buttons still show the paused message for writes.

## Migrations to apply (Supabase)

In order (also listed in `scripts/apply-all-migrations.mjs`):

1. `office_radius_all_employees_2026-10-12.sql` (if not already)
2. `office_multi_locations_assign_2026-10-12.sql`
3. **`assignment_driven_location_shift_2026-10-12.sql`** ← this file

```bash
# Local / CI helper (needs SUPABASE_ACCESS_TOKEN + project ref in env as used by the script)
node scripts/apply-all-migrations.mjs
```

Or paste/run the three SQL files in the Supabase SQL editor (same order).

## Push for Vercel

Do **not** rely on the agent to push. After you verify locally:

```bash
git add -A
git commit -m "Make location and shift attendance assignment-driven"
git push origin HEAD
```

Vercel picks up the frontend from GitHub. Apply the SQL on Supabase separately so RPCs match the new UI.

## Files

- `supabase/migrations/assignment_driven_location_shift_2026-10-12.sql`
- `supabase/migrations/office_multi_locations_assign_2026-10-12.sql`
- `supabase/migrations/office_radius_all_employees_2026-10-12.sql`
- `scripts/apply-all-migrations.mjs`
- `src/utils/attendanceRulesPaused.ts`
- `src/utils/shiftHelpers.ts`
- `src/utils/geoAttendance.ts`
- `src/components/GeoAttendancePanel.tsx`
- `src/components/OfficeLocationSettings.tsx`
- `src/components/AssignManagerLocationPanel.tsx` (assign UI)
