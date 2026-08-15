-- Live tracking matrix: work site + manager for every employee, not only
-- those with a direct manager_id. Also show today's clock in/out in PKT.

-- Backfill missing reporting managers from the same department
UPDATE public.users u
SET manager_id = (
    SELECT m.id
    FROM public.users m
    WHERE m.role = 'manager'::public.user_role
      AND m.is_demo = u.is_demo
      AND m.is_platform_owner = false
      AND m.department_id IS NOT NULL
      AND m.department_id = u.department_id
      AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
    ORDER BY m.full_name
    LIMIT 1
)
WHERE u.role = 'employee'::public.user_role
  AND u.manager_id IS NULL
  AND u.department_id IS NOT NULL
  AND u.is_platform_owner = false;

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

    -- 2) Any manager in the same department
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

    -- 4) Company office location
    RETURN QUERY
    SELECT o.id, o.name, o.latitude, o.longitude, o.radius_meters, o.active, v_mgr
    FROM public.office_locations o
    WHERE o.active = true
      AND o.is_demo = v_user.is_demo
    ORDER BY o.updated_at DESC NULLS LAST, o.name
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
        WHERE o.active = true AND o.is_demo = u.is_demo
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

GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_location_tracking() TO authenticated;

NOTIFY pgrst, 'reload schema';
