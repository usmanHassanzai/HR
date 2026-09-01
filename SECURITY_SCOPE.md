# Scorr — third-party penetration test scope

**Application:** Scorr (`https://scorr.walfia.ai`)  
**Frontend:** React + Vite on Vercel  
**Backend:** Supabase (PostgreSQL 17, Auth, Storage, Edge Functions) on AWS `ap-northeast-1`  
**Mobile:** Capacitor Android (`ai.walfia.scorr`) and iOS project  

## In scope

### Auth
- Email/password sign-in (`supabase.auth.signInWithPassword`)
- Company registration (`signUp` + `users` / `companies` triggers)
- Forgot password Edge Function (`forgot_password`) — service role resets password
- Admin-created users
- Session in `localStorage` (`sb-*-auth-token`)
- MFA/TOTP gate for admin, manager, and platform owner (demo accounts skipped)

### Edge Functions (HTTPS)
| Function | Auth | Notes |
|---|---|---|
| `kpi_email` | User JWT required | Sends email via Resend; still an authenticated mail send |
| `forgot_password` | Unauthenticated (by design) | Always returns success; uses service role |
| `export_report.ts` | Legacy sample | Uses service role; **not** the live deploy pattern — treat as code risk |
| `auto_score.ts` / `monthly_target.ts` / `ai_narrative.ts` | Service role in source | Confirm whether deployed |

Invoke URL shape: `https://<project-ref>.supabase.co/functions/v1/<name>`

### Data API
PostgREST + RPC on `https://<project-ref>.supabase.co/rest/v1` with the **anon** key + user JWT. Privileged work is mostly `SECURITY DEFINER` RPCs (`process_geo_attendance_ping`, attendance, KPI assign, etc.).

### Storage
- Code also references bucket `reports` in `export_report.ts`

### RLS-protected tables (live)
users, kpis, kpi_submissions, tasks, notifications, points_ledger, rewards_catalog, reward_redemptions, leave_balances, leave_requests, attendance_records, attendance_visit_segments, attendance_monthly_reports, daily_work_reports, departments, department_kpi_indicators, companies, platform_owner_notifications, office_locations, manager_work_sites, employee_work_sites, employee_location_pings

### Tables with RLS **disabled** (high priority)
- `work_shifts`
- `employee_shift_assignments`  
  (also granted to `anon` — proposed fix in `supabase/migrations/rls_review_proposed.sql`, **not applied**)

## Out of scope (unless agreed)
- Supabase Dashboard / AWS physical security
- Vercel platform
- Social engineering of staff
- Denial-of-service flooding

## Suggested test cases
1. Cross-tenant read/write using a second company admin JWT  
2. Direct REST on `work_shifts` with anon and authenticated keys  
3. Unauthenticated `forgot_password` and `kpi_email`  
4. Privilege escalation: employee JWT calling admin RPCs  
5. MFA bypass: admin session without AAL2  
6. GPS ping RPCs as another user_id  

## Contacts
Platform owner: info@walfia.ai / dashboard org `walfia-hr-kpi`
