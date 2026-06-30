-- Geofence attendance: office locations + auto clock in/out

CREATE TABLE IF NOT EXISTS public.office_locations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    address      TEXT,
    latitude     DOUBLE PRECISION NOT NULL,
    longitude    DOUBLE PRECISION NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (radius_meters >= 30 AND radius_meters <= 2000),
    active       BOOLEAN NOT NULL DEFAULT true,
    is_demo      BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.attendance_records
    ADD COLUMN IF NOT EXISTS clock_in_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS clock_out_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS clock_in_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS clock_in_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS clock_out_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS clock_out_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS attendance_source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_office_locations_active ON public.office_locations(active) WHERE active = true;

-- Haversine distance in meters
CREATE OR REPLACE FUNCTION public.haversine_meters(
    p_lat1 DOUBLE PRECISION, p_lng1 DOUBLE PRECISION,
    p_lat2 DOUBLE PRECISION, p_lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
    r CONSTANT DOUBLE PRECISION := 6371000;
    dlat DOUBLE PRECISION := radians(p_lat2 - p_lat1);
    dlng DOUBLE PRECISION := radians(p_lng2 - p_lng1);
    a DOUBLE PRECISION;
BEGIN
    a := sin(dlat / 2) ^ 2 + cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(dlng / 2) ^ 2;
    RETURN 2 * r * asin(sqrt(least(1.0, a)));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.is_within_office(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE(office_id UUID, office_name TEXT, distance_meters DOUBLE PRECISION) AS $$
BEGIN
    RETURN QUERY
    SELECT o.id, o.name,
           public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)::DOUBLE PRECISION
    FROM public.office_locations o
    WHERE o.active = true
      AND (NOT public.is_demo_user(auth.uid()) OR o.is_demo = true)
    ORDER BY public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_office_locations()
RETURNS SETOF public.office_locations AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN
        IF public.is_demo_user(auth.uid()) THEN
            RETURN QUERY SELECT * FROM public.office_locations WHERE is_demo = true ORDER BY name;
        ELSE
            RETURN QUERY SELECT * FROM public.office_locations ORDER BY name;
        END IF;
    ELSE
        RETURN QUERY
        SELECT * FROM public.office_locations o
        WHERE o.active = true
          AND (NOT public.is_demo_user(auth.uid()) OR o.is_demo = true)
        ORDER BY o.name;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 150,
    p_active BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(auth.uid());
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins can manage office locations';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Office name is required';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        RAISE EXCEPTION 'Latitude and longitude are required';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, active, is_demo)
        VALUES (trim(p_name), NULLIF(trim(p_address), ''), p_latitude, p_longitude, p_radius_meters, p_active, v_demo)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.office_locations SET
            name = trim(p_name),
            address = NULLIF(trim(p_address), ''),
            latitude = p_latitude,
            longitude = p_longitude,
            radius_meters = p_radius_meters,
            active = p_active,
            updated_at = now()
        WHERE id = p_id
          AND (NOT v_demo OR is_demo = true)
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_office_location(p_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins can delete office locations';
    END IF;
    DELETE FROM public.office_locations
    WHERE id = p_id
      AND (NOT public.is_demo_user(auth.uid()) OR is_demo = true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_today_geo_attendance()
RETURNS TABLE(
    record_id UUID,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_source TEXT,
    is_inside_office BOOLEAN,
    nearest_office TEXT,
    distance_meters DOUBLE PRECISION
) AS $$
DECLARE
    v_office RECORD;
BEGIN
    RETURN QUERY
    SELECT
        ar.id,
        ar.attendance_date,
        ar.status,
        ar.approval_status,
        ar.clock_in_at,
        ar.clock_out_at,
        ar.attendance_source,
        false,
        NULL::TEXT,
        NULL::DOUBLE PRECISION
    FROM public.attendance_records ar
    WHERE ar.user_id = auth.uid()
      AND ar.attendance_date = CURRENT_DATE
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Process GPS ping: auto clock-in when entering office, clock-out when leaving
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_role public.user_role;
    v_office RECORD;
    v_inside BOOLEAN := false;
    v_rec public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_action TEXT := 'none';
    v_office_name TEXT;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    SELECT * INTO v_office FROM public.is_within_office(p_latitude, p_longitude) LIMIT 1;
    IF v_office.office_id IS NOT NULL AND v_office.distance_meters <= (
        SELECT radius_meters FROM public.office_locations WHERE id = v_office.office_id
    ) THEN
        v_inside := true;
        v_office_name := v_office.office_name;
    END IF;

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
                'Auto clock-in at ' || COALESCE(v_office_name, 'office')
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
                notes = COALESCE(notes, '') || ' | Auto clock-out (left office)'
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
        'office_name', v_office_name,
        'distance_meters', COALESCE(v_office.distance_meters, NULL),
        'clock_in_at', v_rec.clock_in_at,
        'clock_out_at', v_rec.clock_out_at,
        'record_id', v_rec.id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER TABLE public.office_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS office_locations_select ON public.office_locations;
CREATE POLICY office_locations_select ON public.office_locations FOR SELECT
USING (
    public.is_admin(auth.uid())
    OR (active = true AND (NOT public.is_demo_user(auth.uid()) OR is_demo = true))
);

DROP POLICY IF EXISTS office_locations_admin ON public.office_locations;
CREATE POLICY office_locations_admin ON public.office_locations FOR ALL
USING (public.is_admin(auth.uid()) AND (NOT public.is_demo_user(auth.uid()) OR is_demo = true))
WITH CHECK (public.is_admin(auth.uid()) AND (NOT public.is_demo_user(auth.uid()) OR is_demo = true));

GRANT EXECUTE ON FUNCTION public.get_office_locations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_office_location(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_today_geo_attendance() TO authenticated;

-- Seed production office (Walfia / Arrant Technologies — Bahria Town Karachi)
INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, active, is_demo)
SELECT
    'Walfia Office — Arrant Technologies',
    'Office 601 & 602, 6th Floor, Arqam Plaza, IV Midway Commercial A, near Bahria Head Office, Bahria Town Karachi, Pakistan',
    25.0255035,
    67.3043054,
    150,
    true,
    false
WHERE NOT EXISTS (
    SELECT 1 FROM public.office_locations
    WHERE name = 'Walfia Office — Arrant Technologies' AND is_demo = false
);

-- Seed demo office (same GPS zone for sandbox testing)
INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, active, is_demo)
SELECT
    'Demo Office — HQ',
    'Office 601 & 602, Arqam Plaza, Bahria Town Karachi (demo sandbox)',
    25.0255035,
    67.3043054,
    150,
    true,
    true
WHERE NOT EXISTS (
    SELECT 1 FROM public.office_locations
    WHERE name = 'Demo Office — HQ' AND is_demo = true
);
