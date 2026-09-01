-- REVIEW ONLY — remaining catalog policy. Shift RLS lives in rls_work_shifts.sql
-- (already applied). Do not apply this file until reviewed.
--
-- This file is intentionally NOT listed in scripts/apply-all-migrations.mjs.

DROP POLICY IF EXISTS catalog_read ON public.rewards_catalog;
-- Catalog has no company_id today (shared list). Restrict to signed-in users
-- so the anon key cannot read it. Split-by-company needs a later schema change.
CREATE POLICY catalog_read ON public.rewards_catalog
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS catalog_admin ON public.rewards_catalog;
CREATE POLICY catalog_admin ON public.rewards_catalog
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));
