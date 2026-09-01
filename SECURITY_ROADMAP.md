# Scorr security roadmap (SOC 2 / ISO 27001)

This is a **gap analysis**, not a certification. Controls below map to SOC 2 Trust Services Criteria and typical ISO 27001 Annex A themes.

## Current controls (in place)

| Area | What exists |
|---|---|
| **CC6 / A.9 Access** | Supabase Auth; app roles employee / manager / admin / platform owner; RLS on most tables via `auth.uid()`, `can_access_user_data`, `same_company` |
| **CC6 Encryption in transit** | HTTPS to Vercel and `*.supabase.co` |
| **CC6 Secrets in frontend** | Browser/APK uses only `VITE_SUPABASE_URL` + **anon** key |
| **CC7 Logging** | Idle session sign-out (`usePortalSessionGuard`); Edge Function logs on Supabase |
| **CC9 Vendor** | Data hosted on Supabase/AWS; app on Vercel |
| **Privacy (partial)** | Forgot-password does not reveal whether an email exists |

## Gaps vs SOC 2 TSC

### Security (CC)
- **MFA:** App TOTP now required for live admin/manager (demo skipped). **Supabase Dashboard MFA is still manual.**
- **RLS:** `work_shifts` and `employee_shift_assignments` have **RLS off** and grants to **anon**.
- **`rewards_catalog` SELECT `USING (true)`** — any role including anon if granted; catalog is global (no `company_id`).
- **FORCE ROW LEVEL SECURITY** is not set on tables.
- **Service role** used in `forgot_password` (needed for Auth Admin API). Legacy functions (`export_report`, `auto_score`) fetch **all KPIs** with service role.
- **`kpi_email`:** now requires a user JWT; still lets any logged-in user send arbitrary `to`/`body` (mail misuse).
- **Git:** `.env` was committed in `3e1b8b2` (placeholder anon key, not service_role). Local `.env` with service_role is gitignored.
- **No formal access reviews, change tickets, or pentest evidence.**

### Availability (A)
- **Free plan:** no PITR, limited backups, 500 MB DB cap, pause risk.
- No documented RTO/RPO or restore test.

### Processing integrity (PI)
- Most writes go through RPCs; some tables still writable if RLS/grants are wrong (shift tables).
- No independent batch reconciliation of attendance vs GPS pings.

### Confidentiality (C)
- Disk encryption at rest is **AWS/Supabase default** — verify in dashboard; no app-level field encryption for GPS or HR notes.
- Service role in local `.env` is a full-database secret.

### Privacy (P)
- No published privacy notice / DPA pack in-repo.
- GPS location stored in `employee_location_pings`.
- No documented retention/deletion SLA beyond `platform_delete_company`.

## ISO 27001-style next actions
1. Apply (after review) `supabase/migrations/rls_review_proposed.sql`  
2. Upgrade Supabase **Pro**, enable **PITR**, test restore  
3. Enable **Dashboard MFA** for every org owner  
4. Rotate keys if `.env` or PAT ever leaked  
5. Commission the pentest using `SECURITY_SCOPE.md`  
6. Add `company_id` to `rewards_catalog` if catalogs must not be global  
7. Restrict `kpi_email` recipients (allow-list company users)  
8. Written IR plan: `INCIDENT_RESPONSE.md` (rehearse yearly)

## Manual dashboard checklist
- [ ] Authentication → MFA (dashboard users)  
- [ ] Settings → confirm encryption at rest (platform default)  
- [ ] Billing → Pro + PITR  
- [ ] API → confirm service_role never in Vercel **VITE_** vars  
- [ ] Auth → enable TOTP for the project (if MFA API returns “not enabled”)
