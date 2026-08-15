-- Scope office locations (and related geo RPCs) to each company.
-- Previously every org saw every office GPS zone.

ALTER TABLE public.office_locations
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_office_locations_company
  ON public.office_locations (company_id)
  WHERE company_id IS NOT NULL;

-- Backfill from manager work-site assignments
UPDATE public.office_locations o
SET company_id = sub.company_id
FROM (
    SELECT DISTINCT ON (mws.office_location_id)
        mws.office_location_id,
        u.company_id
    FROM public.manager_work_sites mws
    JOIN public.users u ON u.id = mws.manager_id
    WHERE mws.office_location_id IS NOT NULL
      AND u.company_id IS NOT NULL
    ORDER BY mws.office_location_id, mws.updated_at DESC NULLS LAST
) sub
WHERE o.id = sub.office_location_id
  AND o.company_id IS NULL
  AND o.is_demo = false;

-- Known Walfia HQ seed → walfia-default company
UPDATE public.office_locations o
SET company_id = c.id
FROM public.companies c
WHERE c.slug = 'walfia-default'
  AND o.company_id IS NULL
  AND o.is_demo = false
  AND (
      o.name ILIKE '%Walfia%'
      OR o.name ILIKE '%Arrant%'
  );

-- Orphan non-demo offices (no company): deactivate so they cannot leak
UPDATE public.office_locations
SET active = false,
    updated_at = timezone('utc'::text, now())
WHERE company_id IS NULL
  AND is_demo = false
  AND active = true;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.office_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS office_locations_select ON public.office_locations;
DROP POLICY IF EXISTS office_locations_admin_all ON public.office_locations;
DROP POLICY IF EXISTS office_locations_admin ON public.office_locations;

CREATE POLICY office_locations_select ON public.office_locations
FOR SELECT USING (
    (
        public.is_demo_user(auth.uid()) AND is_demo = true
    )
    OR (
        NOT public.is_demo_user(auth.uid())
        AND company_id IS NOT NULL
        AND company_id = public.current_company_id()
        AND (
            public.is_admin(auth.uid())
            OR active = true
        )
    )
);

CREATE POLICY office_locations_admin_write ON public.office_locations
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

DROP POLICY IF EXISTS manager_work_sites_select ON public.manager_work_sites;
DROP POLICY IF EXISTS manager_work_sites_admin ON public.manager_work_sites;
DROP POLICY IF EXISTS manager_work_sites_admin_all ON public.manager_work_sites;

CREATE POLICY manager_work_sites_select ON public.manager_work_sites
FOR SELECT USING (
    manager_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.users e
        WHERE e.id = auth.uid() AND e.manager_id = manager_work_sites.manager_id
    )
    OR (
        public.is_admin(auth.uid())
        AND EXISTS (
            SELECT 1 FROM public.users m
            WHERE m.id = manager_work_sites.manager_id
              AND (
                  (public.is_demo_user(auth.uid()) AND m.is_demo = true)
                  OR (
                      NOT public.is_demo_user(auth.uid())
                      AND m.company_id IS NOT NULL
                      AND m.company_id = public.current_company_id()
                  )
              )
        )
    )
);

CREATE POLICY manager_work_sites_admin_write ON public.manager_work_sites
FOR ALL USING (
    public.is_admin(auth.uid())
    AND EXISTS (
        SELECT 1 FROM public.users m
        WHERE m.id = manager_work_sites.manager_id
          AND (
              (public.is_demo_user(auth.uid()) AND m.is_demo = true)
              OR public.same_company(m.id)
          )
    )
)
WITH CHECK (
    public.is_admin(auth.uid())
    AND EXISTS (
        SELECT 1 FROM public.users m
        WHERE m.id = manager_id
          AND (
              (public.is_demo_user(auth.uid()) AND m.is_demo = true)
              OR public.same_company(m.id)
          )
    )
);

-- ─── RPCs ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_office_locations()
RETURNS SETOF public.office_locations AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT * FROM public.office_locations o
        WHERE o.is_demo = true
          AND (public.is_admin(v_uid) OR o.active = true)
        ORDER BY o.name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT * FROM public.office_locations o
    WHERE o.company_id = v_company
      AND (public.is_admin(v_uid) OR o.active = true)
    ORDER BY o.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 50,
    p_active BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(v_uid);
    v_company UUID;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can manage office locations';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Office name is required';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        RAISE EXCEPTION 'Latitude and longitude are required';
    END IF;

    IF NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (
            name, address, latitude, longitude, radius_meters, active, is_demo, company_id
        ) VALUES (
            trim(p_name),
            NULLIF(trim(p_address), ''),
            p_latitude,
            p_longitude,
            COALESCE(p_radius_meters, 50),
            p_active,
            v_demo,
            v_company
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.office_locations SET
            name = trim(p_name),
            address = NULLIF(trim(p_address), ''),
            latitude = p_latitude,
            longitude = p_longitude,
            radius_meters = COALESCE(p_radius_meters, 50),
            active = p_active,
            updated_at = now()
        WHERE id = p_id
          AND (
              (v_demo AND is_demo = true)
              OR (NOT v_demo AND company_id = v_company)
          )
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_office_location(p_id UUID)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can delete office locations';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        DELETE FROM public.office_locations
        WHERE id = p_id AND is_demo = true;
    ELSE
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
        DELETE FROM public.office_locations
        WHERE id = p_id AND company_id = v_company;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Office location not found';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_within_office(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE(office_id UUID, office_name TEXT, distance_meters DOUBLE PRECISION) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RETURN; END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT o.id, o.name,
               public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)::DOUBLE PRECISION
        FROM public.office_locations o
        WHERE o.active = true AND o.is_demo = true
        ORDER BY public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
        LIMIT 1;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT o.id, o.name,
           public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)::DOUBLE PRECISION
    FROM public.office_locations o
    WHERE o.active = true
      AND o.company_id = v_company
    ORDER BY public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_manager_work_site(
    p_manager_id UUID,
    p_office_location_id UUID DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_radius_meters INTEGER DEFAULT 50,
    p_tracking_enabled BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_mgr_demo BOOLEAN;
    v_lat DOUBLE PRECISION := p_latitude;
    v_lng DOUBLE PRECISION := p_longitude;
    v_name TEXT := NULLIF(trim(p_name), '');
    v_address TEXT := NULLIF(trim(p_address), '');
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_mgr_role public.user_role;
    v_company UUID;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign manager work locations';
    END IF;
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'Manager is required'; END IF;

    SELECT role, is_demo INTO v_mgr_role, v_mgr_demo FROM public.users WHERE id = p_manager_id;
    IF v_mgr_role IS DISTINCT FROM 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Work locations can only be assigned to managers';
    END IF;

    PERFORM public.enforce_demo_isolation(p_manager_id);

    IF NOT public.is_demo_user(v_caller) THEN
        IF NOT public.same_company(p_manager_id) THEN
            RAISE EXCEPTION 'Manager is not in your organization';
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
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.manager_work_sites (
        manager_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_manager_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        COALESCE(p_radius_meters, 50), COALESCE(p_tracking_enabled, true), v_caller, COALESCE(v_mgr_demo, false)
    )
    ON CONFLICT (manager_id) DO UPDATE SET
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

CREATE OR REPLACE FUNCTION public.remove_manager_work_site(p_manager_id UUID)
RETURNS VOID AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins can remove manager work locations';
    END IF;

    IF public.is_demo_user(auth.uid()) THEN
        DELETE FROM public.manager_work_sites
        WHERE manager_id = p_manager_id AND is_demo = true;
    ELSE
        IF NOT public.same_company(p_manager_id) THEN
            RAISE EXCEPTION 'Manager is not in your organization';
        END IF;
        DELETE FROM public.manager_work_sites
        WHERE manager_id = p_manager_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_manager_work_sites()
RETURNS TABLE(
    site_id UUID,
    manager_id UUID,
    manager_name TEXT,
    manager_email TEXT,
    team_count BIGINT,
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
        RAISE EXCEPTION 'Only admins can view manager work sites';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT
            mws.id,
            m.id,
            m.full_name,
            m.email,
            (SELECT COUNT(*) FROM public.users e WHERE e.manager_id = m.id AND e.role = 'employee'::public.user_role),
            mws.name,
            mws.address,
            mws.latitude,
            mws.longitude,
            mws.radius_meters,
            mws.tracking_enabled,
            mws.updated_at
        FROM public.manager_work_sites mws
        JOIN public.users m ON m.id = mws.manager_id
        WHERE mws.is_demo = true
        ORDER BY m.full_name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT
        mws.id,
        m.id,
        m.full_name,
        m.email,
        (SELECT COUNT(*) FROM public.users e WHERE e.manager_id = m.id AND e.role = 'employee'::public.user_role),
        mws.name,
        mws.address,
        mws.latitude,
        mws.longitude,
        mws.radius_meters,
        mws.tracking_enabled,
        mws.updated_at
    FROM public.manager_work_sites mws
    JOIN public.users m ON m.id = mws.manager_id
    WHERE m.company_id = v_company
      AND m.is_demo = false
    ORDER BY m.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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

    -- 4) Company office location only (never another org)
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

-- Fix office fallback in live tracking matrix to same company only
CREATE OR REPLACE FUNCTION public.get_team_location_tracking()
RETURNS TABLE(
    user_id UUID,
    full_name TEXT,
    email TEXT,
    role public.user_role,
    manager_id UUID,
    manager_name TEXT,
    site_id UUID,
    site_name TEXT,
    site_address TEXT,
    site_latitude DOUBLE PRECISION,
    site_longitude DOUBLE PRECISION,
    site_radius_meters INTEGER,
    tracking_enabled BOOLEAN,
    last_ping_at TIMESTAMPTZ,
    last_latitude DOUBLE PRECISION,
    last_longitude DOUBLE PRECISION,
    inside_site BOOLEAN,
    distance_meters DOUBLE PRECISION,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_status public.attendance_status,
    attendance_source TEXT
) AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_caller_role public.user_role;
    v_caller_dept UUID;
    v_company UUID;
    v_today DATE := (timezone('Asia/Karachi', now()))::date;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT u.role, u.department_id INTO v_caller_role, v_caller_dept
    FROM public.users u
    WHERE u.id = v_caller;

    IF NOT public.is_admin(v_caller) AND v_caller_role <> 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Only managers and admins can view live tracking';
    END IF;

    IF NOT public.is_demo_user(v_caller) THEN
        v_company := public.current_company_id();
    END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        COALESCE(u.manager_id, dept_mgr.id, CASE WHEN u.role = 'manager'::public.user_role THEN u.id END),
        COALESCE(mgr.full_name, dept_mgr.full_name),
        COALESCE(own_site.id, dept_site.id, co_site.id, office.id),
        COALESCE(own_site.name, dept_site.name, co_site.name, office.name),
        COALESCE(own_site.address, dept_site.address, co_site.address, office.address),
        COALESCE(own_site.latitude, dept_site.latitude, co_site.latitude, office.latitude),
        COALESCE(own_site.longitude, dept_site.longitude, co_site.longitude, office.longitude),
        COALESCE(own_site.radius_meters, dept_site.radius_meters, co_site.radius_meters, office.radius_meters),
        COALESCE(own_site.tracking_enabled, dept_site.tracking_enabled, co_site.tracking_enabled, office.active, false),
        COALESCE(lp.recorded_at, ar.clock_in_at, ar.clock_out_at),
        lp.latitude,
        lp.longitude,
        COALESCE(lp.inside_site, false),
        lp.distance_meters,
        ar.clock_in_at,
        ar.clock_out_at,
        ar.status,
        ar.attendance_source
    FROM public.users u
    LEFT JOIN public.users mgr ON mgr.id = CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END
    LEFT JOIN LATERAL (
        SELECT m.id, m.full_name
        FROM public.users m
        WHERE m.role = 'manager'::public.user_role
          AND m.is_demo = u.is_demo
          AND u.department_id IS NOT NULL
          AND m.department_id = u.department_id
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY CASE WHEN m.id = u.manager_id THEN 0 ELSE 1 END, m.full_name
        LIMIT 1
    ) dept_mgr ON true
    LEFT JOIN public.manager_work_sites own_site ON own_site.manager_id = CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END AND own_site.tracking_enabled = true
    LEFT JOIN LATERAL (
        SELECT mws.*
        FROM public.manager_work_sites mws
        JOIN public.users m ON m.id = mws.manager_id
        WHERE mws.tracking_enabled = true
          AND m.role = 'manager'::public.user_role
          AND m.is_demo = u.is_demo
          AND u.department_id IS NOT NULL
          AND m.department_id = u.department_id
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY mws.updated_at DESC
        LIMIT 1
    ) dept_site ON true
    LEFT JOIN LATERAL (
        SELECT mws.*
        FROM public.manager_work_sites mws
        JOIN public.users m ON m.id = mws.manager_id
        WHERE mws.tracking_enabled = true
          AND m.is_demo = u.is_demo
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY mws.updated_at DESC
        LIMIT 1
    ) co_site ON true
    LEFT JOIN LATERAL (
        SELECT o.id, o.name, o.address, o.latitude, o.longitude, o.radius_meters, o.active
        FROM public.office_locations o
        WHERE o.active = true
          AND o.is_demo = u.is_demo
          AND (
              (u.is_demo = true AND o.company_id IS NULL)
              OR (u.company_id IS NOT NULL AND o.company_id = u.company_id)
          )
        ORDER BY o.name
        LIMIT 1
    ) office ON true
    LEFT JOIN LATERAL (
        SELECT p.*
        FROM public.employee_location_pings p
        WHERE p.user_id = u.id
        ORDER BY p.recorded_at DESC
        LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
        SELECT a.clock_in_at, a.clock_out_at, a.status, a.attendance_source
        FROM public.attendance_records a
        WHERE a.user_id = u.id
          AND a.attendance_date IN (v_today, CURRENT_DATE)
        ORDER BY CASE WHEN a.attendance_date = v_today THEN 0 ELSE 1 END, a.clock_in_at DESC NULLS LAST
        LIMIT 1
    ) ar ON true
    WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
      AND (
          public.is_admin(v_caller)
          OR (
              v_caller_role = 'manager'::public.user_role
              AND v_caller_dept IS NOT NULL
              AND u.department_id = v_caller_dept
          )
      )
      AND (
          (public.is_demo_user(v_caller) AND u.is_demo = true)
          OR (
              NOT public.is_demo_user(v_caller)
              AND u.is_demo = false
              AND (v_company IS NULL OR u.company_id = v_company)
          )
      )
    ORDER BY u.role DESC, u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_office_locations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_office_location(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_within_office(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_manager_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_manager_work_site(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_work_sites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_location_tracking() TO authenticated;

NOTIFY pgrst, 'reload schema';
