-- office_multi_locations_assign_2026-10-12.sql
-- One office → many location pins. People may be assigned 1+ locations.
-- Presence/radius uses ONLY assigned location(s) (OR across them). No org-wide office fallback.

-- ---------------------------------------------------------------------------
-- 1) Parent offices table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_offices_company
  ON public.offices (company_id)
  WHERE company_id IS NOT NULL;

ALTER TABLE public.offices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offices_select ON public.offices;
CREATE POLICY offices_select ON public.offices
FOR SELECT USING (
  (public.is_demo_user(auth.uid()) AND is_demo = true)
  OR (
    NOT public.is_demo_user(auth.uid())
    AND company_id IS NOT NULL
    AND company_id = public.current_company_id()
    AND (public.is_admin(auth.uid()) OR active = true)
  )
);

DROP POLICY IF EXISTS offices_admin_write ON public.offices;
CREATE POLICY offices_admin_write ON public.offices
FOR ALL USING (
  public.is_admin(auth.uid())
  AND (
    (public.is_demo_user(auth.uid()) AND is_demo = true)
    OR (
      NOT public.is_demo_user(auth.uid())
      AND company_id IS NOT NULL
      AND company_id = public.current_company_id()
    )
  )
)
WITH CHECK (
  public.is_admin(auth.uid())
  AND (
    (public.is_demo_user(auth.uid()) AND is_demo = true)
    OR (
      NOT public.is_demo_user(auth.uid())
      AND company_id IS NOT NULL
      AND company_id = public.current_company_id()
    )
  )
);

-- ---------------------------------------------------------------------------
-- 2) Link office_locations → offices
-- ---------------------------------------------------------------------------
ALTER TABLE public.office_locations
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES public.offices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_office_locations_office
  ON public.office_locations (office_id)
  WHERE office_id IS NOT NULL;

-- Backfill: each existing location becomes its own parent office (1:1)
DO $$
DECLARE
  r RECORD;
  v_office_id UUID;
BEGIN
  FOR r IN
    SELECT id, name, company_id, is_demo, active
    FROM public.office_locations
    WHERE office_id IS NULL
  LOOP
    INSERT INTO public.offices (company_id, name, active, is_demo)
    VALUES (r.company_id, r.name, COALESCE(r.active, true), COALESCE(r.is_demo, false))
    RETURNING id INTO v_office_id;

    UPDATE public.office_locations
    SET office_id = v_office_id
    WHERE id = r.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Multi-assign: one person → many location rows
-- ---------------------------------------------------------------------------
ALTER TABLE public.employee_work_sites
  DROP CONSTRAINT IF EXISTS employee_work_sites_user_id_key;

-- Deduplicate before unique (keep newest per user+location)
DELETE FROM public.employee_work_sites a
USING public.employee_work_sites b
WHERE a.office_location_id IS NOT NULL
  AND a.office_location_id = b.office_location_id
  AND a.user_id = b.user_id
  AND a.id < b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employee_work_sites_user_location_key'
  ) THEN
    ALTER TABLE public.employee_work_sites
      ADD CONSTRAINT employee_work_sites_user_location_key
      UNIQUE (user_id, office_location_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_work_sites_user
  ON public.employee_work_sites(user_id);

-- ---------------------------------------------------------------------------
-- 4) Office CRUD RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_offices()
RETURNS TABLE(
  id UUID,
  name TEXT,
  active BOOLEAN,
  is_demo BOOLEAN,
  company_id UUID,
  location_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT
      o.id, o.name, o.active, o.is_demo, o.company_id,
      (SELECT COUNT(*) FROM public.office_locations l WHERE l.office_id = o.id),
      o.created_at, o.updated_at
    FROM public.offices o
    WHERE o.is_demo = true
      AND (public.is_admin(v_uid) OR o.active = true)
    ORDER BY o.name;
    RETURN;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    o.id, o.name, o.active, o.is_demo, o.company_id,
    (SELECT COUNT(*) FROM public.office_locations l WHERE l.office_id = o.id),
    o.created_at, o.updated_at
  FROM public.offices o
  WHERE o.company_id = v_company
    AND (public.is_admin(v_uid) OR o.active = true)
  ORDER BY o.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_offices() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_office(
  p_id UUID,
  p_name TEXT,
  p_active BOOLEAN DEFAULT true
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
  v_demo BOOLEAN := public.is_demo_user(v_uid);
  v_company UUID;
BEGIN
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can manage offices';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Office name is required';
  END IF;

  IF NOT v_demo THEN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.offices (name, active, is_demo, company_id)
    VALUES (trim(p_name), COALESCE(p_active, true), v_demo, v_company)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.offices SET
      name = trim(p_name),
      active = COALESCE(p_active, active),
      updated_at = timezone('utc'::text, now())
    WHERE id = p_id
      AND (
        (v_demo AND is_demo = true)
        OR (NOT v_demo AND company_id = v_company)
      )
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Office not found'; END IF;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_office(UUID, TEXT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_office(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can delete offices';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    DELETE FROM public.offices WHERE id = p_id AND is_demo = true;
  ELSE
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    DELETE FROM public.offices WHERE id = p_id AND company_id = v_company;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Office not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_office(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5) Location upsert under a parent office
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_office_location(
  p_id uuid,
  p_name text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters integer DEFAULT 150,
  p_active boolean DEFAULT true,
  p_wifi_ssids text[] DEFAULT NULL,
  p_wifi_bssids text[] DEFAULT NULL,
  p_public_ip_cidrs text[] DEFAULT NULL,
  p_detection_mode text DEFAULT NULL,
  p_office_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
  v_demo BOOLEAN := public.is_demo_user(v_uid);
  v_company UUID;
  v_mode text;
  v_office_id UUID := p_office_id;
  v_parent public.offices%ROWTYPE;
BEGIN
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can manage office locations';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Location name is required';
  END IF;
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'Latitude and longitude are required';
  END IF;

  v_mode := COALESCE(NULLIF(btrim(p_detection_mode), ''), 'gps_or_wifi');

  IF NOT v_demo THEN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
  END IF;

  -- Resolve / create parent office
  IF v_office_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.offices
    WHERE id = v_office_id
      AND (
        (v_demo AND is_demo = true)
        OR (NOT v_demo AND company_id = v_company)
      );
    IF NOT FOUND THEN RAISE EXCEPTION 'Office not found'; END IF;
  ELSIF p_id IS NOT NULL THEN
    SELECT office_id INTO v_office_id FROM public.office_locations WHERE id = p_id;
  END IF;

  IF v_office_id IS NULL THEN
    INSERT INTO public.offices (name, active, is_demo, company_id)
    VALUES (trim(p_name), COALESCE(p_active, true), v_demo, v_company)
    RETURNING id INTO v_office_id;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.office_locations (
      name, address, latitude, longitude, radius_meters, active, is_demo, company_id,
      wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode, office_id
    ) VALUES (
      trim(p_name),
      NULLIF(trim(p_address), ''),
      p_latitude,
      p_longitude,
      GREATEST(COALESCE(p_radius_meters, 150), 1),
      p_active,
      v_demo,
      v_company,
      COALESCE(p_wifi_ssids, '{}'),
      COALESCE(p_wifi_bssids, '{}'),
      COALESCE(p_public_ip_cidrs, '{}'),
      v_mode::public.office_detection_mode,
      v_office_id
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.office_locations SET
      name = trim(p_name),
      address = NULLIF(trim(p_address), ''),
      latitude = p_latitude,
      longitude = p_longitude,
      radius_meters = GREATEST(COALESCE(p_radius_meters, 150), 1),
      active = p_active,
      wifi_ssids = COALESCE(p_wifi_ssids, wifi_ssids),
      wifi_bssids = COALESCE(p_wifi_bssids, wifi_bssids),
      public_ip_cidrs = COALESCE(p_public_ip_cidrs, public_ip_cidrs),
      detection_mode = v_mode::public.office_detection_mode,
      office_id = COALESCE(v_office_id, office_id),
      updated_at = timezone('utc'::text, now())
    WHERE id = p_id
      AND (
        (v_demo AND is_demo = true)
        OR (NOT v_demo AND company_id = v_company)
      )
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
  END IF;

  PERFORM public.sync_work_sites_to_office(v_id);
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_office_location(uuid, text, text, double precision, double precision, integer, boolean, text[], text[], text[], text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6) Assign: add one location (keeps other assignments)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_employee_work_site(
  p_user_id UUID,
  p_office_location_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT NULL,
  p_address TEXT DEFAULT NULL,
  p_latitude DOUBLE PRECISION DEFAULT NULL,
  p_longitude DOUBLE PRECISION DEFAULT NULL,
  p_radius_meters INTEGER DEFAULT 150,
  p_tracking_enabled BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_target_demo BOOLEAN;
  v_target_role public.user_role;
  v_lat DOUBLE PRECISION := p_latitude;
  v_lng DOUBLE PRECISION := p_longitude;
  v_name TEXT := NULLIF(trim(p_name), '');
  v_address TEXT := NULLIF(trim(p_address), '');
  v_radius INTEGER := COALESCE(p_radius_meters, 150);
  v_id UUID;
  v_office public.office_locations%ROWTYPE;
  v_company UUID;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;
  IF p_office_location_id IS NULL THEN RAISE EXCEPTION 'Location is required'; END IF;

  IF NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Only admins can assign employee office locations';
  END IF;

  SELECT role, is_demo INTO v_target_role, v_target_demo
  FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_target_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RAISE EXCEPTION 'Office GPS can only be assigned to employees, managers, or HR';
  END IF;

  PERFORM public.enforce_demo_isolation(p_user_id);

  IF NOT public.is_demo_user(v_caller) THEN
    IF NOT public.same_company(p_user_id) THEN
      RAISE EXCEPTION 'User is not in your organization';
    END IF;
    v_company := public.current_company_id();
  END IF;

  SELECT * INTO v_office FROM public.office_locations
  WHERE id = p_office_location_id
    AND (
      (public.is_demo_user(v_caller) AND is_demo = true)
      OR (NOT public.is_demo_user(v_caller) AND company_id = v_company)
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

  v_lat := v_office.latitude;
  v_lng := v_office.longitude;
  v_name := COALESCE(v_name, v_office.name);
  v_address := COALESCE(v_address, v_office.address);
  v_radius := COALESCE(v_office.radius_meters, v_radius, 150);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, address, latitude, longitude,
    radius_meters, tracking_enabled, assigned_by, is_demo
  ) VALUES (
    p_user_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
    GREATEST(COALESCE(v_radius, 150), 1), COALESCE(p_tracking_enabled, true),
    v_caller, COALESCE(v_target_demo, false)
  )
  ON CONFLICT (user_id, office_location_id) DO UPDATE SET
    name = EXCLUDED.name,
    address = EXCLUDED.address,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    radius_meters = EXCLUDED.radius_meters,
    tracking_enabled = EXCLUDED.tracking_enabled,
    assigned_by = v_caller,
    is_demo = EXCLUDED.is_demo,
    updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_employee_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;

-- Replace a person's location set (multi-select save)
CREATE OR REPLACE FUNCTION public.set_employee_work_sites(
  p_user_id UUID,
  p_office_location_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_count INTEGER := 0;
  v_loc UUID;
  v_ids UUID[] := COALESCE(p_office_location_ids, '{}');
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Only admins can assign employee office locations';
  END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;

  -- Drop assignments not in the new set
  IF cardinality(v_ids) = 0 THEN
    DELETE FROM public.employee_work_sites WHERE user_id = p_user_id;
  ELSE
    DELETE FROM public.employee_work_sites
    WHERE user_id = p_user_id
      AND (office_location_id IS NULL OR NOT (office_location_id = ANY (v_ids)));
  END IF;

  FOREACH v_loc IN ARRAY v_ids LOOP
    IF v_loc IS NULL THEN CONTINUE; END IF;
    PERFORM public.assign_employee_work_site(p_user_id, v_loc, NULL, NULL, NULL, NULL, NULL, true);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_employee_work_sites(UUID, UUID[]) TO authenticated;

-- Remove one assignment row
CREATE OR REPLACE FUNCTION public.remove_employee_work_site_by_id(p_site_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.employee_work_sites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can remove employee office locations';
  END IF;

  SELECT * INTO v_row FROM public.employee_work_sites WHERE id = p_site_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found'; END IF;

  IF public.is_demo_user(v_uid) THEN
    IF NOT v_row.is_demo THEN RAISE EXCEPTION 'Assignment not found'; END IF;
  ELSE
    IF NOT public.same_company(v_row.user_id) THEN
      RAISE EXCEPTION 'User is not in your organization';
    END IF;
  END IF;

  DELETE FROM public.employee_work_sites WHERE id = p_site_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_employee_work_site_by_id(UUID) TO authenticated;

-- Keep bulk clear-by-user
CREATE OR REPLACE FUNCTION public.remove_employee_work_site(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can remove employee office locations';
  END IF;

  IF public.is_demo_user(auth.uid()) THEN
    DELETE FROM public.employee_work_sites
    WHERE user_id = p_user_id AND is_demo = true;
  ELSE
    IF NOT public.same_company(p_user_id) THEN
      RAISE EXCEPTION 'User is not in your organization';
    END IF;
    DELETE FROM public.employee_work_sites WHERE user_id = p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.remove_employee_work_site(UUID) TO authenticated;

-- Assign one location to all staff (adds; does not clear other locations)
CREATE OR REPLACE FUNCTION public.assign_office_to_all_employees(p_office_location_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_office public.office_locations%ROWTYPE;
  v_company UUID;
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Only admins can assign office locations';
  END IF;
  IF p_office_location_id IS NULL THEN RAISE EXCEPTION 'Location is required'; END IF;

  IF public.is_demo_user(v_caller) THEN
    SELECT * INTO v_office FROM public.office_locations
    WHERE id = p_office_location_id AND is_demo = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

    FOR r IN
      SELECT id, role FROM public.users
      WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role)
        AND is_demo = true
    LOOP
      PERFORM public.assign_employee_work_site(
        r.id, p_office_location_id, v_office.name, v_office.address,
        v_office.latitude, v_office.longitude, v_office.radius_meters, true
      );
      IF r.role = 'manager'::public.user_role THEN
        PERFORM public.assign_manager_work_site(
          r.id, p_office_location_id, v_office.name, v_office.address,
          v_office.latitude, v_office.longitude, v_office.radius_meters, true
        );
      END IF;
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RAISE EXCEPTION 'No organization found'; END IF;

  SELECT * INTO v_office FROM public.office_locations
  WHERE id = p_office_location_id AND company_id = v_company;
  IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

  FOR r IN
    SELECT id, role FROM public.users
    WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role)
      AND company_id = v_company
      AND COALESCE(is_demo, false) = false
  LOOP
    PERFORM public.assign_employee_work_site(
      r.id, p_office_location_id, v_office.name, v_office.address,
      v_office.latitude, v_office.longitude, v_office.radius_meters, true
    );
    IF r.role = 'manager'::public.user_role THEN
      PERFORM public.assign_manager_work_site(
        r.id, p_office_location_id, v_office.name, v_office.address,
        v_office.latitude, v_office.longitude, v_office.radius_meters, true
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_office_to_all_employees(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7) List assignments with location + parent office ids
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_employee_work_sites()
RETURNS TABLE(
  site_id UUID,
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_role public.user_role,
  site_name TEXT,
  site_address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  updated_at TIMESTAMPTZ,
  office_location_id UUID,
  office_id UUID,
  office_name TEXT
) AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Only admins can view employee work sites';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT
      ews.id,
      u.id,
      u.full_name,
      u.email,
      u.role,
      COALESCE(o.name, ews.name),
      COALESCE(o.address, ews.address),
      COALESCE(o.latitude, ews.latitude),
      COALESCE(o.longitude, ews.longitude),
      COALESCE(o.radius_meters, ews.radius_meters),
      ews.tracking_enabled,
      ews.updated_at,
      ews.office_location_id,
      o.office_id,
      ofc.name
    FROM public.employee_work_sites ews
    JOIN public.users u ON u.id = ews.user_id
    LEFT JOIN public.office_locations o ON o.id = ews.office_location_id
    LEFT JOIN public.offices ofc ON ofc.id = o.office_id
    WHERE ews.is_demo = true
    ORDER BY u.full_name, COALESCE(ofc.name, ''), COALESCE(o.name, ews.name);
    RETURN;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    ews.id,
    u.id,
    u.full_name,
    u.email,
    u.role,
    COALESCE(o.name, ews.name),
    COALESCE(o.address, ews.address),
    COALESCE(o.latitude, ews.latitude),
    COALESCE(o.longitude, ews.longitude),
    COALESCE(o.radius_meters, ews.radius_meters),
    ews.tracking_enabled,
    ews.updated_at,
    ews.office_location_id,
    o.office_id,
    ofc.name
  FROM public.employee_work_sites ews
  JOIN public.users u ON u.id = ews.user_id
  LEFT JOIN public.office_locations o ON o.id = ews.office_location_id
  LEFT JOIN public.offices ofc ON ofc.id = o.office_id
  WHERE u.company_id = v_company
    AND u.is_demo = false
  ORDER BY u.full_name, COALESCE(ofc.name, ''), COALESCE(o.name, ews.name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_employee_work_sites() TO authenticated;

-- ---------------------------------------------------------------------------
-- 8) Presence: only assigned locations; OR across them
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_work_sites_for_user(p_user_id UUID)
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID,
  office_location_id UUID,
  office_id UUID,
  office_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_mgr UUID;
  v_personal_count INTEGER := 0;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_mgr := CASE
    WHEN v_user.role = 'manager'::public.user_role THEN v_user.id
    ELSE v_user.manager_id
  END;

  SELECT COUNT(*) INTO v_personal_count
  FROM public.employee_work_sites ews
  WHERE ews.user_id = p_user_id
    AND ews.tracking_enabled = true
    AND ews.is_demo = v_user.is_demo;

  -- Personal assignments (may be multiple locations) — exclusive; no other locations apply
  IF v_personal_count > 0 THEN
    RETURN QUERY
    SELECT
      ews.id,
      COALESCE(o.name, ews.name),
      COALESCE(o.latitude, ews.latitude),
      COALESCE(o.longitude, ews.longitude),
      COALESCE(o.radius_meters, ews.radius_meters, 150),
      ews.tracking_enabled,
      v_mgr,
      ews.office_location_id,
      o.office_id,
      ofc.name
    FROM public.employee_work_sites ews
    LEFT JOIN public.office_locations o
      ON o.id = ews.office_location_id
     AND COALESCE(o.active, true) = true
     AND o.is_demo = v_user.is_demo
    LEFT JOIN public.offices ofc ON ofc.id = o.office_id
    WHERE ews.user_id = p_user_id
      AND ews.tracking_enabled = true
      AND ews.is_demo = v_user.is_demo
      AND COALESCE(o.latitude, ews.latitude) IS NOT NULL
      AND COALESCE(o.longitude, ews.longitude) IS NOT NULL
    ORDER BY COALESCE(ofc.name, ''), COALESCE(o.name, ews.name);
    RETURN;
  END IF;

  -- Direct manager team zone only (single). No dept/company/org office fallback.
  IF v_mgr IS NOT NULL THEN
    RETURN QUERY
    SELECT
      mws.id,
      COALESCE(o.name, mws.name),
      COALESCE(o.latitude, mws.latitude),
      COALESCE(o.longitude, mws.longitude),
      COALESCE(o.radius_meters, mws.radius_meters, 150),
      mws.tracking_enabled,
      mws.manager_id,
      mws.office_location_id,
      o.office_id,
      ofc.name
    FROM public.manager_work_sites mws
    LEFT JOIN public.office_locations o
      ON o.id = mws.office_location_id
     AND COALESCE(o.active, true) = true
     AND o.is_demo = v_user.is_demo
    LEFT JOIN public.offices ofc ON ofc.id = o.office_id
    WHERE mws.manager_id = v_mgr
      AND mws.tracking_enabled = true
      AND COALESCE(o.latitude, mws.latitude) IS NOT NULL
      AND COALESCE(o.longitude, mws.longitude) IS NOT NULL
    LIMIT 1;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_work_sites_for_user(UUID) TO authenticated;

-- Singular: first assigned site (compat). Prefer get_work_sites_for_user for multi.
CREATE OR REPLACE FUNCTION public.get_work_site_for_user(p_user_id UUID)
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.site_id,
    s.site_name,
    s.latitude,
    s.longitude,
    s.radius_meters,
    s.tracking_enabled,
    s.manager_id
  FROM public.get_work_sites_for_user(p_user_id) s
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_work_site()
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY SELECT * FROM public.get_work_site_for_user(auth.uid());
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_work_site() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_work_sites()
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID,
  office_location_id UUID,
  office_id UUID,
  office_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY SELECT * FROM public.get_work_sites_for_user(auth.uid());
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_work_sites() TO authenticated;

-- Presence: inside if within ANY assigned location radius
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_site RECORD;
  v_distance DOUBLE PRECISION;
  v_radius INTEGER;
  v_inside BOOLEAN := false;
  v_action TEXT := 'outside_office';
  v_any BOOLEAN := false;
  v_best_name TEXT;
  v_best_lat DOUBLE PRECISION;
  v_best_lng DOUBLE PRECISION;
  v_best_radius INTEGER;
  v_best_dist DOUBLE PRECISION;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'skipped',
      'reason', 'Geo attendance is for employees, managers, and HR only',
      'message', 'Attendance writes are paused. Office radius checks apply to employees, managers, and HR.'
    );
  END IF;

  FOR v_site IN
    SELECT * FROM public.get_work_sites_for_user(v_user_id)
  LOOP
    v_any := true;
    v_radius := GREATEST(COALESCE(v_site.radius_meters, 150), 1);
    v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
    IF v_distance IS NOT NULL AND v_distance <= v_radius THEN
      v_inside := true;
      v_best_name := v_site.site_name;
      v_best_lat := v_site.latitude;
      v_best_lng := v_site.longitude;
      v_best_radius := v_radius;
      v_best_dist := v_distance;
      EXIT;
    END IF;
    IF v_best_lat IS NULL OR (v_distance IS NOT NULL AND (v_best_dist IS NULL OR v_distance < v_best_dist)) THEN
      v_best_name := v_site.site_name;
      v_best_lat := v_site.latitude;
      v_best_lng := v_site.longitude;
      v_best_radius := v_radius;
      v_best_dist := v_distance;
    END IF;
  END LOOP;

  IF NOT v_any OR v_best_lat IS NULL OR v_best_lng IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'outside_office',
      'reason', 'no_work_site',
      'inside_office', false,
      'message', 'No office location assigned. Ask admin: Office & Attendance → Assign people. Only assigned locations count for radius.'
    );
  END IF;

  v_radius := GREATEST(COALESCE(v_best_radius, 150), 1);
  v_distance := COALESCE(v_best_dist, public.haversine_meters(p_latitude, p_longitude, v_best_lat, v_best_lng));
  IF NOT v_inside THEN
    v_inside := v_distance IS NOT NULL AND v_distance <= v_radius;
  END IF;
  v_action := CASE WHEN v_inside THEN 'inside_office' ELSE 'outside_radius' END;

  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'action', v_action,
    'reason', 'rules_not_configured',
    'inside_office', v_inside,
    'office_name', v_best_name,
    'distance_meters', ROUND(v_distance)::integer,
    'radius_meters', v_radius,
    'effective_radius_meters', v_radius,
    'message', CASE
      WHEN v_inside THEN
        'Inside assigned location radius (' || v_radius || 'm). Attendance check-in/out writes are still paused while rules are rebuilt.'
      ELSE
        'Outside your assigned location(s) (' || v_radius || 'm). Other office locations do not apply. Attendance writes remain paused.'
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text,
  p_is_mock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'gps_unusable',
      'reason', 'gps_unusable',
      'inside_office', false,
      'message', 'Mock location is not allowed for office radius checks. Attendance writes remain paused.'
    );
  END IF;
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
