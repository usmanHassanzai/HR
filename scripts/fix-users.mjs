/**
 * One-off maintenance:
 *  1. Backfill public.users profiles for any auth.users missing one
 *     (so every login account appears in the User Directory).
 *  2. Restore the seed manager relationship.
 *  3. (Re)create the admin-only delete_user_admin RPC + grant.
 */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const SQL = `
-- 1. Backfill missing profiles from auth metadata
INSERT INTO public.users (id, email, full_name, role)
SELECT
  a.id,
  a.email,
  COALESCE(a.raw_user_meta_data->>'full_name', a.email),
  COALESCE((a.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role)
FROM auth.users a
WHERE NOT EXISTS (SELECT 1 FROM public.users p WHERE p.id = a.id);

-- 2. Restore the demo manager relationship
UPDATE public.users AS e
SET manager_id = m.id
FROM public.users AS m
WHERE e.email = 'employee@walfia.ai' AND m.email = 'manager@walfia.ai';

-- 3. Admin-only full delete RPC
CREATE OR REPLACE FUNCTION public.delete_user_admin(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can delete users';
    END IF;
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'You cannot delete your own account';
    END IF;
    DELETE FROM auth.users WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.delete_user_admin(UUID) TO authenticated;

-- Report
SELECT email, role, manager_id IS NOT NULL AS has_manager FROM public.users ORDER BY email;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: SQL }),
});
const body = await res.json();
console.log(res.ok ? 'OK' : 'ERROR', JSON.stringify(body, null, 2));
process.exit(res.ok ? 0 : 1);
