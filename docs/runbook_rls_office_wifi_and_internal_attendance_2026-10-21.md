# Production runbook: RLS on Wi-Fi networks and attendance internals

Do not run this until the migration has been reviewed. It was tested on scorr-staging (`utxylrrrzsjetncrajxj`) only. Production (`yvnbxweitelowucdhwpg`) was not changed.

## What this changes

One migration: `supabase/migrations/rls_office_wifi_and_internal_attendance_2026-10-21.sql`

| Table | RLS | Policies |
| --- | --- | --- |
| `public.office_wifi_networks` | ON | Company members SELECT. Admin and HR of that company INSERT, UPDATE, DELETE. |
| `public.attendance_auto_close_suppressed` | ON | None |
| `public.attendance_events_log_archive` | ON | None |
| `public.employee_location_pings_archive` | ON | None |

Any extra table whose name starts with `attendance_auto_close_suppress` or `employee_location_pings_archive` gets RLS and no policies. Existing policies are not dropped.

## Who still works after RLS

- Auto check-in Wi-Fi matching uses `attendance_match_office_wifi`, which is `SECURITY DEFINER`. It keeps reading networks.
- Admin and HR Wi-Fi editing uses `replace_office_wifi_networks` / `delete_office_wifi_network` (`SECURITY DEFINER`, `is_admin()` which includes HR). Direct table writes from those roles are also allowed by the new policies.
- Retention uses `attendance_retention_cleanup()` (`SECURITY DEFINER`, execute granted to `service_role`) and the `scorr-attendance-retention` cron. Those bypass RLS.
- `service_role` bypasses RLS. The anon key does not.

## Apply

1. Confirm the four names in the Security Advisor match the table above.
2. Take a note of the current advisor `rls_disabled_in_public` list.
3. Run the migration SQL in the Supabase SQL editor for production, or your usual migration apply path. Do not run the rollback in the same step.
4. Re-open Security Advisor. Those four `rls_disabled_in_public` errors should be gone. Internal tables may show `rls_enabled_no_policy` at INFO level. That is expected.
5. Smoke check: an employee assigned to an office still matches that office SSID; an Admin or HR user can save a Wi-Fi network; a user from another company cannot open it.

## Rollback

Run `supabase/migrations/ROLLBACK_rls_office_wifi_and_internal_attendance_2026-10-21.sql`.

It drops only the four policies this migration added, then turns RLS off when no other policy remains. It does not delete rows. If another policy was added later, it stops and leaves RLS on.
