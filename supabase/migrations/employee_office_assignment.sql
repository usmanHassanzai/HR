-- Direct office GPS assignment for employees (individual + assign all).
-- Personal assignment takes priority over manager team sites.

CREATE TABLE IF NOT EXISTS public.employee_work_sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    office_location_id UUID REFERENCES public.office_locations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    address TEXT,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (radius_meters >= 30 AND radius_meters <= 2000),
    tracking_enabled BOOLEAN NOT NULL DEFAULT true,
    assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_work_sites_user
  ON public.employee_work_sites(user_id);

CREATE INDEX IF NOT EXISTS idx_employee_work_sites_office
  ON public.employee_work_sites(office_location_id);

ALTER TABLE public.employee_work_sites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_work_sites_select ON public.employee_work_sites;
CREATE POLICY employee_work_sites_select ON public.employee_work_sites
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR public.is_manager_of(auth.uid(), user_id)
  );

-- Pings may reference manager or employee site ids
ALTER TABLE public.employee_location_pings
  DROP CONSTRAINT IF EXISTS employee_location_pings_work_site_id_fkey;

-- ── Assign one employee / manager ──────────────────────────────────────────
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
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_company UUID;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;

    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign employee office locations';
    END IF;

    SELECT role, is_demo INTO v_target_role, v_target_demo
    FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    IF v_target_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RAISE EXCEPTION 'Office GPS can only be assigned to employees or managers';
    END IF;

    PERFORM public.enforce_demo_isolation(p_user_id);

    IF NOT public.is_demo_user(v_caller) THEN
        IF NOT public.same_company(p_user_id) THEN
            RAISE EXCEPTION 'User is not in your organization';
        END IF;
        v_company := public.current_company_id();
    END IF;

    IF p_office_location_id IS NOT NULL THEN
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
        p_radius_meters := COALESCE(p_radius_meters, v_office.radius_meters);
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.employee_work_sites (
        user_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_user_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        COALESCE(p_radius_meters, 150), COALESCE(p_tracking_enabled, true),
        v_caller, COALESCE(v_target_demo, false)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        office_location_id = EXCLUDED.office_location_id,
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

-- ── Assign office to every employee in the org ─────────────────────────────
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
    IF p_office_location_id IS NULL THEN RAISE EXCEPTION 'Office is required'; END IF;

    IF public.is_demo_user(v_caller) THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id AND is_demo = true;
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

        FOR r IN
            SELECT id, is_demo FROM public.users
            WHERE role = 'employee'::public.user_role
              AND is_demo = true
        LOOP
            PERFORM public.assign_employee_work_site(
                r.id, p_office_location_id, v_office.name, v_office.address,
                v_office.latitude, v_office.longitude, v_office.radius_meters, true
            );
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
        SELECT id FROM public.users
        WHERE role = 'employee'::public.user_role
          AND company_id = v_company
          AND COALESCE(is_demo, false) = false
    LOOP
        PERFORM public.assign_employee_work_site(
            r.id, p_office_location_id, v_office.name, v_office.address,
            v_office.latitude, v_office.longitude, v_office.radius_meters, true
        );
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
    updated_at TIMESTAMPTZ
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
            ews.name,
            ews.address,
            ews.latitude,
            ews.longitude,
            ews.radius_meters,
            ews.tracking_enabled,
            ews.updated_at
        FROM public.employee_work_sites ews
        JOIN public.users u ON u.id = ews.user_id
        WHERE ews.is_demo = true
        ORDER BY u.full_name;
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
        ews.name,
        ews.address,
        ews.latitude,
        ews.longitude,
        ews.radius_meters,
        ews.tracking_enabled,
        ews.updated_at
    FROM public.employee_work_sites ews
    JOIN public.users u ON u.id = ews.user_id
    WHERE u.company_id = v_company
      AND COALESCE(u.is_demo, false) = false
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Prefer personal employee assignment, then manager team site, then fallbacks
CREATE OR REPLACE FUNCTION public.get_work_site_for_user(p_user_id UUID)
RETURNS TABLE(
    site_id UUID,
    site_name TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_meters INTEGER,
    tracking_enabled BOOLEAN,
    manager_id UUID
) AS $$
DECLARE
    v_user public.users%ROWTYPE;
    v_mgr UUID;
BEGIN
    SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN; END IF;

    v_mgr := CASE
        WHEN v_user.role = 'manager'::public.user_role THEN v_user.id
        ELSE v_user.manager_id
    END;

    -- 0) Direct personal office assignment
    RETURN QUERY
    SELECT ews.id, ews.name, ews.latitude, ews.longitude, ews.radius_meters, ews.tracking_enabled, v_mgr
    FROM public.employee_work_sites ews
    WHERE ews.user_id = p_user_id
      AND ews.tracking_enabled = true
      AND ews.is_demo = v_user.is_demo
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 1) Assigned manager / self site
    IF v_mgr IS NOT NULL THEN
        RETURN QUERY
        SELECT mws.id, mws.name, mws.latitude, mws.longitude, mws.radius_meters, mws.tracking_enabled, mws.manager_id
        FROM public.manager_work_sites mws
        WHERE mws.manager_id = v_mgr AND mws.tracking_enabled = true
        LIMIT 1;
        IF FOUND THEN RETURN; END IF;
    END IF;

    -- 2) Any manager in the same department (same company)
    RETURN QUERY
    SELECT mws.id, mws.name, mws.latitude, mws.longitude, mws.radius_meters, mws.tracking_enabled, mws.manager_id
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    WHERE mws.tracking_enabled = true
      AND m.role = 'manager'::public.user_role
      AND m.is_demo = v_user.is_demo
      AND v_user.department_id IS NOT NULL
      AND m.department_id = v_user.department_id
      AND (v_user.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM v_user.company_id)
    ORDER BY mws.updated_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 3) Any company manager site
    RETURN QUERY
    SELECT mws.id, mws.name, mws.latitude, mws.longitude, mws.radius_meters, mws.tracking_enabled, mws.manager_id
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    WHERE mws.tracking_enabled = true
      AND m.is_demo = v_user.is_demo
      AND (v_user.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM v_user.company_id)
    ORDER BY mws.updated_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 4) Company office location only
    RETURN QUERY
    SELECT o.id, o.name, o.latitude, o.longitude, o.radius_meters, o.active, v_mgr
    FROM public.office_locations o
    WHERE o.active = true
      AND o.is_demo = v_user.is_demo
      AND (
          (v_user.is_demo = true AND o.company_id IS NULL)
          OR (v_user.company_id IS NOT NULL AND o.company_id = v_user.company_id)
      )
    ORDER BY o.updated_at DESC NULLS LAST, o.name
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_employee_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_office_to_all_employees(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_employee_work_site(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_work_sites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
