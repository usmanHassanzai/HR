-- Manager-level work sites: admin assigns one GPS zone per manager; all direct reports share it

CREATE TABLE IF NOT EXISTS public.manager_work_sites (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manager_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    office_location_id UUID REFERENCES public.office_locations(id) ON DELETE SET NULL,
    name               TEXT NOT NULL,
    address            TEXT,
    latitude           DOUBLE PRECISION NOT NULL,
    longitude          DOUBLE PRECISION NOT NULL,
    radius_meters      INTEGER NOT NULL DEFAULT 150 CHECK (radius_meters >= 30 AND radius_meters <= 2000),
    tracking_enabled   BOOLEAN NOT NULL DEFAULT true,
    assigned_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
    is_demo            BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (manager_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_work_sites_manager ON public.manager_work_sites(manager_id);

-- Migrate existing per-employee sites → manager sites (if any)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'employee_work_sites') THEN
        INSERT INTO public.manager_work_sites (
            manager_id, office_location_id, name, address, latitude, longitude,
            radius_meters, tracking_enabled, assigned_by, is_demo
        )
        SELECT DISTINCT ON (target_mgr)
            target_mgr,
            ews.office_location_id,
            ews.name,
            ews.address,
            ews.latitude,
            ews.longitude,
            ews.radius_meters,
            ews.tracking_enabled,
            ews.assigned_by,
            ews.is_demo
        FROM public.employee_work_sites ews
        JOIN public.users u ON u.id = ews.user_id
        CROSS JOIN LATERAL (
            SELECT CASE
                WHEN u.role = 'manager'::public.user_role THEN u.id
                ELSE u.manager_id
            END AS target_mgr
        ) m
        WHERE m.target_mgr IS NOT NULL
        ORDER BY target_mgr, ews.updated_at DESC
        ON CONFLICT (manager_id) DO NOTHING;

        ALTER TABLE public.employee_location_pings
            DROP CONSTRAINT IF EXISTS employee_location_pings_work_site_id_fkey;

        DROP TABLE public.employee_work_sites;
    END IF;
END $$;

ALTER TABLE public.employee_location_pings
    DROP CONSTRAINT IF EXISTS employee_location_pings_work_site_id_fkey;

ALTER TABLE public.employee_location_pings
    ADD CONSTRAINT employee_location_pings_work_site_id_fkey
    FOREIGN KEY (work_site_id) REFERENCES public.manager_work_sites(id) ON DELETE SET NULL;

-- Resolve work site for any user via their manager (or own site if they are a manager)
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
    v_mgr UUID;
BEGIN
    SELECT CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END INTO v_mgr
    FROM public.users u
    WHERE u.id = p_user_id;

    IF v_mgr IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT
        mws.id,
        mws.name,
        mws.latitude,
        mws.longitude,
        mws.radius_meters,
        mws.tracking_enabled,
        mws.manager_id
    FROM public.manager_work_sites mws
    WHERE mws.manager_id = v_mgr
      AND mws.tracking_enabled = true
      AND (NOT public.is_demo_user(p_user_id) OR mws.is_demo = true)
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.get_employee_work_site(UUID);

-- Admin only: assign work location to a manager (applies to whole team)
CREATE OR REPLACE FUNCTION public.assign_manager_work_site(
    p_manager_id UUID,
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
    v_demo BOOLEAN := public.is_demo_user(v_caller);
    v_lat DOUBLE PRECISION := p_latitude;
    v_lng DOUBLE PRECISION := p_longitude;
    v_name TEXT := NULLIF(trim(p_name), '');
    v_address TEXT := NULLIF(trim(p_address), '');
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_mgr_role public.user_role;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign manager work locations';
    END IF;
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'Manager is required'; END IF;

    SELECT role INTO v_mgr_role FROM public.users WHERE id = p_manager_id;
    IF v_mgr_role IS DISTINCT FROM 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Work locations can only be assigned to managers';
    END IF;

    PERFORM public.enforce_demo_isolation(p_manager_id);

    IF p_office_location_id IS NOT NULL THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id
          AND (NOT v_demo OR is_demo = true);
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
        COALESCE(p_radius_meters, 150), COALESCE(p_tracking_enabled, true), v_caller, v_demo
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
    DELETE FROM public.manager_work_sites
    WHERE manager_id = p_manager_id
      AND (NOT public.is_demo_user(auth.uid()) OR is_demo = true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.assign_employee_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS public.remove_employee_work_site(UUID);

-- All manager location assignments (admin overview)
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
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins can view manager work sites';
    END IF;

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
    WHERE NOT public.is_demo_user(auth.uid()) OR mws.is_demo = true
    ORDER BY m.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.get_team_location_tracking();

-- Live tracking: team members inherit site from their manager
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
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) AND (SELECT role FROM public.users WHERE id = v_caller) <> 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Only managers and admins can view live tracking';
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
          NOT public.is_demo_user(v_caller)
          OR public.is_demo_user(u.id)
      )
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Geo ping uses manager's shared work site
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_role public.user_role;
    v_office RECORD;
    v_site RECORD;
    v_inside BOOLEAN := false;
    v_rec public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_action TEXT := 'none';
    v_site_name TEXT;
    v_distance DOUBLE PRECISION;
    v_radius INTEGER;
    v_work_site_id UUID;
    v_demo BOOLEAN;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    SELECT * INTO v_site FROM public.get_work_site_for_user(v_user_id) LIMIT 1;
    IF v_site.site_id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
        v_radius := v_site.radius_meters;
        v_work_site_id := v_site.site_id;
        v_site_name := v_site.site_name;
        v_inside := v_distance <= v_radius;
    ELSE
        SELECT * INTO v_office FROM public.is_within_office(p_latitude, p_longitude) LIMIT 1;
        IF v_office.office_id IS NOT NULL THEN
            SELECT radius_meters INTO v_radius FROM public.office_locations WHERE id = v_office.office_id;
            v_distance := v_office.distance_meters;
            v_site_name := v_office.office_name;
            v_inside := v_distance <= v_radius;
        END IF;
    END IF;

    INSERT INTO public.employee_location_pings (
        user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
        v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );

    SELECT * INTO v_rec FROM public.attendance_records
    WHERE user_id = v_user_id AND attendance_date = CURRENT_DATE;

    IF v_inside THEN
        IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, notes
            ) VALUES (
                v_user_id, CURRENT_DATE, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'geo',
                'Auto clock-in at ' || COALESCE(v_site_name, 'work site')
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_in_lat = COALESCE(public.attendance_records.clock_in_lat, EXCLUDED.clock_in_lat),
                clock_in_lng = COALESCE(public.attendance_records.clock_in_lng, EXCLUDED.clock_in_lng),
                status = CASE WHEN public.attendance_records.clock_out_at IS NULL THEN 'present' ELSE public.attendance_records.status END,
                approval_status = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'approved'::public.approval_status ELSE public.attendance_records.approval_status END,
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'geo' ELSE public.attendance_records.attendance_source END,
                notes = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.notes ELSE public.attendance_records.notes END,
                reviewed_by = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_user_id ELSE public.attendance_records.reviewed_by END,
                reviewed_at = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_now ELSE public.attendance_records.reviewed_at END
            RETURNING * INTO v_rec;
            v_action := 'clock_in';
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            v_action := 'already_clocked_in';
        END IF;
    ELSE
        IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                notes = COALESCE(notes, '') || ' | Auto clock-out (left work site)'
            WHERE id = v_rec.id
            RETURNING * INTO v_rec;
            v_action := 'clock_out';
        ELSE
            v_action := 'outside_office';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'action', v_action,
        'inside_office', v_inside,
        'office_name', v_site_name,
        'distance_meters', v_distance,
        'clock_in_at', v_rec.clock_in_at,
        'clock_out_at', v_rec.clock_out_at,
        'record_id', v_rec.id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER TABLE public.manager_work_sites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_work_sites_select ON public.manager_work_sites;
CREATE POLICY manager_work_sites_select ON public.manager_work_sites FOR SELECT
USING (
    public.is_admin(auth.uid())
    OR manager_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.users e
        WHERE e.id = auth.uid() AND e.manager_id = manager_work_sites.manager_id
    )
);

GRANT EXECUTE ON FUNCTION public.assign_manager_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_manager_work_site(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_work_sites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_work_site_for_user(UUID) TO authenticated;
