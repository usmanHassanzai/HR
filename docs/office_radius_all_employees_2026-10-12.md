# Office → locations → multi-assign — 2026-10-12

## Data model

| Layer | Table | Meaning |
| --- | --- | --- |
| Office | `offices` | Parent (e.g. Karachi HQ). Company-scoped. |
| Location | `office_locations` | Pin + radius under an office (`office_id`). Many per office. |
| Assignment | `employee_work_sites` | **One row per (person, location)**. Unique `(user_id, office_location_id)`. |

## Assignment exclusivity

- A person may be assigned **1 or many** locations (checkboxes → `set_employee_work_sites`).
- Presence ORs across **only** those assigned pins: inside A **or** B counts; C does not apply.
- Personal assignments win. If none, direct manager team zone (single) may apply.
- **No** org-wide “latest active office” fallback — unassigned people have no radius until assigned.

## Presence

`process_geo_attendance_ping` / `get_work_sites_for_user` read assigned rows only (live pin+radius from `office_locations` when linked).

## Migrations to apply (live DB)

1. `office_radius_all_employees_2026-10-12.sql` (if not already)
2. `office_multi_locations_assign_2026-10-12.sql` ← offices parent + multi-assign + exclusive presence

Listed in `scripts/apply-all-migrations.mjs`. Do **not** auto-deploy; push to GitHub/Vercel yourself and run migrations on Supabase.

## Files

- `supabase/migrations/office_multi_locations_assign_2026-10-12.sql`
- `scripts/apply-all-migrations.mjs`
- `src/components/OfficeLocationSettings.tsx`
- `src/components/AssignManagerLocationPanel.tsx`
- `src/components/GeoAttendancePanel.tsx`
- `src/utils/geoAttendance.ts`
- `src/styles/admin-office.css`
- `src/utils/attendanceRulesPaused.ts` (unchanged — rules still paused)

## Remaining stubs

Attendance **writes**, auto Wi‑Fi/shift rules, and related edge stubs stay paused until rebuilt.
