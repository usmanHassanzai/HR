CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
    v_n INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check out for a future date'; END IF;

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
        RAISE EXCEPTION 'Check in first, then you can check out';
    END IF;
    IF v_rec.status = 'absent' THEN
        RAISE EXCEPTION 'Cannot check out on an absent day';
    END IF;
    IF v_rec.clock_out_at IS NOT NULL THEN
        RAISE EXCEPTION 'Already checked out';
    END IF;

    UPDATE public.attendance_visit_segments
    SET clock_out_at = v_now,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
    WHERE user_id = v_uid
      AND attendance_date = p_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = p_date
    ) THEN
        SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = p_date;
        INSERT INTO public.attendance_visit_segments (
            user_id, attendance_record_id, attendance_date, visit_number,
            clock_in_at, clock_out_at, work_minutes, notes
        ) VALUES (
            v_uid, v_rec.id, p_date, COALESCE(v_n, 1),
            v_rec.clock_in_at, v_now,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
            'Visit 1 · saved session'
        );
    END IF;

    v_total := public.attendance_day_total_minutes(v_uid, p_date, v_now);

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = v_total
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$
