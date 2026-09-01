# Scorr incident response

Use this if a key leaked, a company reports a breach, or you suspect unauthorized access.

## Severity
- **P1:** `service_role`, database password, or PAT leaked; confirmed cross-company data access  
- **P2:** Single user account takeover; accidental public bucket  
- **P3:** Suspicious login, malware on one admin laptop  

## First 60 minutes (P1)
1. **Do not** commit the leaked secret to chat or git.  
2. Supabase Dashboard → **Project Settings → API**: **reset/rotate** `service_role` and `anon` if either leaked. Update Vercel env (`VITE_SUPABASE_ANON_KEY` only) and redeploy.  
3. **Project Settings → Database**: rotate DB password if it was exposed.  
4. Revoke the **Personal Access Token** (PAT) used by deploy scripts if `.env` leaked.  
5. Auth → sign out users: enable “refresh token reuse detection” if available; for a known account, reset that user’s password.  
6. Storage: set leaked buckets to private; remove public policies.  
7. Record: time detected, who reported, what was exposed.

## First 24 hours
- Snapshot: export relevant logs (Auth, Edge Functions, Postgres logs).  
- Identify affected `company_id`s.  
- If HR/attendance/GPS data left the tenant: notify those companies’ admins in writing (what, when, what you did).  
- Reset **forgot_password** / Resend keys if email was abused.  
- Check GitHub: if a secret hit a commit, rotate even if later deleted; history still has it.

## Who to notify
| Role | Contact |
|---|---|
| Platform owner | info@walfia.ai (Supabase org `walfia-hr-kpi`) |
| Engineering | Repo maintainers — rotate keys, deploy  
| Affected company admin | Email on `companies.contact_email` |
| Supabase | Dashboard support if you believe the platform itself was compromised |
| Legal / DPA | If you have customer contracts that require 72-hour notice |

There is **no in-app incident mailbox**. Keep this file updated with a backup phone number.

## What to rotate (checklist)
- [ ] `anon` key (Vercel + `.env` + rebuild APK if baked in)  
- [ ] `service_role` (Edge Function secrets, local `.env` only — never VITE_)  
- [ ] `SUPABASE_PAT`  
- [ ] `RESEND_API_KEY`  
- [ ] User passwords for compromised accounts  
- [ ] GitHub deploy keys / Vercel tokens if CI was involved  

## After recovery
- Confirm RLS on `work_shifts` / `employee_shift_assignments` if that was the path.  
- Force MFA re-enrollment if TOTP secrets may have leaked.  
- Post-incident note: root cause, timeline, customers told.  
- Rehearse this plan at least once per year.

## If Supabase or AWS is down (not a breach)
The app cannot log in or save. Data remains at the provider. Status: status.supabase.com / AWS health. No key rotation unless a compromise is confirmed.
