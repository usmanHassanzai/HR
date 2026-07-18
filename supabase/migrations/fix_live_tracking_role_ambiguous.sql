-- Fix: "column reference role is ambiguous" on Live Tracking page.
-- RETURNS TABLE(role ...) shadows unqualified "role" in subqueries inside PL/pgSQL.

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
    v_company UUID;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT u.role INTO v_caller_role
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
        COALESCE(u.manager_id, CASE WHEN u.role = 'manager'::public.user_role THEN u.id END),
        mgr.full_name,
        mws.id,
        mws.name,
        mws.address,
        mws.latitude,
        mws.longitude,
        mws.radius_meters,
        COALESCE(mws.tracking_enabled, false),
        lp.recorded_at,
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
    LEFT JOIN public.manager_work_sites mws ON mws.manager_id = CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END
    LEFT JOIN LATERAL (
        SELECT p.*
        FROM public.employee_location_pings p
        WHERE p.user_id = u.id
        ORDER BY p.recorded_at DESC
        LIMIT 1
    ) lp ON true
    LEFT JOIN public.attendance_records ar
        ON ar.user_id = u.id AND ar.attendance_date = CURRENT_DATE
    WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
      AND (
          public.is_admin(v_caller)
          OR u.manager_id = v_caller
          OR u.id = v_caller
      )
      AND (
          (public.is_demo_user(v_caller) AND u.is_demo = true)
          OR (
              NOT public.is_demo_user(v_caller)
              AND u.is_demo = false
              AND (v_company IS NULL OR u.company_id = v_company)
          )
      )
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_team_location_tracking() TO authenticated;
