-- attendance_writers_window.sql
-- R2 / R11 / R18 / N2: route all attendance writers through attendance_window_for_user.
-- Old JWT geo path kept working but enforces W + server time immediately.

-- R40: GPS exit needs 2 consecutive outside OR 50m beyond radius
CREATE OR REPLACE FUNCTION public.geo_confirm_left_site(
    p_distance DOUBLE PRECISION,
    p_effective_radius DOUBLE PRECISION,
    p_prev_inside BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_distance IS NULL OR p_effective_radius IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_distance <= p_effective_radius THEN
        RETURN FALSE;
    END IF;
    -- 50 m buffer beyond effective radius
    IF p_distance >= (p_effective_radius + 50) THEN
        RETURN TRUE;
    END IF;
    -- 2 consecutive outside readings
    RETURN p_prev_inside IS FALSE;
END;
$$;

-- resolve_shift_attendance_date → shared window (no hardcoded Karachi for window math)
CREATE OR REPLACE FUNCTION public.resolve_shift_attendance_date(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
BEGIN
  SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, p_at) LIMIT 1;
  IF COALESCE(v_win.has_shift, false) AND v_win.attendance_date IS NOT NULL THEN
    RETURN v_win.attendance_date;
  END IF;
  -- Fallback: company TZ local date (display/legacy only)
  RETURN public.attendance_local_date(p_at, public.company_timezone(
    (SELECT company_id FROM public.users WHERE id = p_user_id)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_shift_date DATE;
    v_rec public.attendance_records%ROWTYPE;
    v_id UUID;
    v_kept INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: check-in only inside the attendance window';
    END IF;

    v_shift_date := COALESCE(p_date, v_win.attendance_date);
    IF v_shift_date IS DISTINCT FROM v_win.attendance_date THEN
        RAISE EXCEPTION 'attendance_outside_window: date does not match current shift window';
    END IF;

    PERFORM public.attendance_realign_shift_records(v_uid);

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

    IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
        PERFORM public.attendance_ensure_open_visit(v_uid, v_rec.id, v_shift_date, v_now, 'Check in');
        RETURN v_rec.id;
    END IF;

    IF FOUND AND v_rec.clock_out_at IS NOT NULL THEN
        PERFORM public.attendance_backfill_closed_visit(
            v_uid, v_rec.id, v_shift_date, v_rec.clock_in_at, v_rec.clock_out_at, v_rec.work_minutes
        );
        v_kept := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);
    ELSE
        v_kept := COALESCE(v_rec.work_minutes, 0);
    END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at, shift_id
    )
    VALUES (
        v_uid, v_shift_date, 'present', 'approved'::public.approval_status, v_uid,
        v_now, NULL, NULLIF(v_kept, 0), 'manual', v_uid, v_now, v_win.shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        approval_status = 'approved'::public.approval_status,
        marked_by = v_uid,
        reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_uid),
        reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        clock_out_at = NULL,
        clock_out_lat = NULL,
        clock_out_lng = NULL,
        work_minutes = COALESCE(
            NULLIF(EXCLUDED.work_minutes, 0),
            NULLIF(public.attendance_records.work_minutes, 0)
        ),
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual'),
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, v_shift_date, v_now, 'Check in');

    UPDATE public.attendance_records
    SET work_minutes = NULLIF(public.attendance_day_total_minutes(v_uid, v_shift_date, v_now), 0)
    WHERE id = v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_shift_date DATE;
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
    v_n INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: check-out only inside the attendance window';
    END IF;

    v_shift_date := COALESCE(p_date, v_win.attendance_date);

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

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
      AND attendance_date = v_shift_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date
    ) THEN
        SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date;
        INSERT INTO public.attendance_visit_segments (
            user_id, attendance_record_id, attendance_date, visit_number,
            clock_in_at, clock_out_at, work_minutes, notes
        ) VALUES (
            v_uid, v_rec.id, v_shift_date, GREATEST(v_n, 1),
            v_rec.clock_in_at, v_now,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
            'Manual check-out'
        );
    END IF;

    v_total := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = v_total
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Employee hybrid remote self-mark: ONLY inside W; present = real check-in time; no synthetic clocks
CREATE OR REPLACE FUNCTION public.mark_hybrid_remote_day(
    p_date DATE DEFAULT CURRENT_DATE,
    p_status public.attendance_status DEFAULT 'present'
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_existing public.attendance_records%ROWTYPE;
    v_notes TEXT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_status NOT IN ('present', 'absent') THEN RAISE EXCEPTION 'Status must be present or absent'; END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF COALESCE(v_me.work_mode, 'office') <> 'hybrid' THEN
        RAISE EXCEPTION 'Only hybrid workers can mark a remote day';
    END IF;
    IF v_me.role NOT IN ('employee', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: remote self-mark only inside the attendance window';
    END IF;
    IF p_date IS DISTINCT FROM v_win.attendance_date THEN
        RAISE EXCEPTION 'attendance_outside_window: date must be the current shift attendance date';
    END IF;

    SELECT * INTO v_existing
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF FOUND AND v_existing.attendance_source IN ('geo', 'auto_gps', 'auto_wifi', 'auto_laptop')
       AND v_existing.clock_in_at IS NOT NULL AND v_existing.clock_out_at IS NULL THEN
        RAISE EXCEPTION 'Already checked in at the office for this date';
    END IF;

    IF p_status = 'absent' THEN
        v_notes := 'Hybrid — marked absent (remote day)';
        INSERT INTO public.attendance_records (
            user_id, attendance_date, status, approval_status, notes, marked_by,
            reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
            work_minutes, shift_id
        ) VALUES (
            v_uid, p_date, 'absent', 'approved', v_notes, v_uid, v_uid, v_now,
            NULL, NULL, 'manual', NULL, v_win.shift_id
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent',
            clock_in_at = NULL,
            clock_out_at = NULL,
            work_minutes = NULL,
            notes = EXCLUDED.notes,
            attendance_source = 'manual',
            marked_by = v_uid,
            reviewed_by = v_uid,
            reviewed_at = v_now
        RETURNING id INTO v_id;
        RETURN v_id;
    END IF;

    -- Present = check-in at real server time (counts as check-in)
    v_notes := 'Hybrid — worked remotely';
    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
        work_minutes, shift_id
    ) VALUES (
        v_uid, p_date, 'present', 'approved', v_notes, v_uid, v_uid, v_now,
        v_now, NULL, 'manual', NULL, v_win.shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        clock_out_at = NULL,
        notes = EXCLUDED.notes,
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual'),
        marked_by = v_uid,
        reviewed_by = v_uid,
        reviewed_at = v_now,
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, p_date, v_now, 'Hybrid remote check-in');
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Supervisor day-status mark for remote/hybrid-home: any time, NO clock times, audited
CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_allowed BOOLEAN := false;
    v_notes TEXT;
    v_before JSONB;
    v_after JSONB;
    v_existing public.attendance_records%ROWTYPE;
    v_day_status BOOLEAN := false;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(p_user_id);
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

    IF public.is_admin(auth.uid()) THEN
        v_allowed := true;
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_allowed := true;
    ELSIF v_me.role IN ('hr', 'admin') AND v_me.company_id IS NOT DISTINCT FROM v_emp.company_id THEN
        v_allowed := true;
    ELSIF v_me.role = 'manager'::public.user_role
          AND v_emp.role = 'employee'::public.user_role
          AND v_me.department_id IS NOT NULL
          AND v_emp.department_id = v_me.department_id
          AND (v_me.company_id IS NULL OR v_emp.company_id IS NOT DISTINCT FROM v_me.company_id) THEN
        v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    v_day_status := COALESCE(v_emp.work_mode, 'office') IN ('remote', 'hybrid');

    v_notes := COALESCE(NULLIF(trim(p_notes), ''),
        CASE
          WHEN v_emp.work_mode = 'remote' THEN 'Remote work — marked by supervisor'
          WHEN v_emp.work_mode = 'hybrid' THEN 'Hybrid home — marked by supervisor'
          ELSE 'Marked by supervisor'
        END
    );

    SELECT * INTO v_existing FROM public.attendance_records
    WHERE user_id = p_user_id AND attendance_date = p_date;

    v_before := CASE WHEN FOUND THEN to_jsonb(v_existing) ELSE '{}'::JSONB END;

    IF v_day_status THEN
      PERFORM public.attendance_set_write_context('day_status');

      INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, notes, marked_by,
          reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source, work_minutes
      )
      VALUES (
          p_user_id, p_date, p_status, 'approved', v_notes, auth.uid(),
          auth.uid(), v_now, NULL, NULL, 'day_status', NULL
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status,
          approval_status = 'approved',
          notes = EXCLUDED.notes,
          marked_by = auth.uid(),
          reviewed_by = auth.uid(),
          reviewed_at = v_now,
          clock_in_at = NULL,
          clock_out_at = NULL,
          work_minutes = NULL,
          attendance_source = 'day_status'
      RETURNING id INTO v_id;

      PERFORM public.attendance_set_write_context('normal');

      SELECT to_jsonb(ar) INTO v_after FROM public.attendance_records ar WHERE ar.id = v_id;

      INSERT INTO public.attendance_corrections_audit (
        company_id, attendance_record_id, target_user_id, actor_user_id,
        reason, before, after, kind
      ) VALUES (
        v_me.company_id, v_id, p_user_id, auth.uid(),
        NULLIF(trim(p_notes), ''), v_before, v_after, 'day_status'
      );
    ELSE
      -- Office workers: supervisor mark still allowed but clock times only if inside W via correction path
      -- Keep status mark without inventing clock times outside W
      PERFORM public.attendance_set_write_context('day_status');
      INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, notes, marked_by,
          reviewed_by, reviewed_at, attendance_source
      )
      VALUES (
          p_user_id, p_date, p_status, 'approved', v_notes, auth.uid(),
          auth.uid(), v_now, 'day_status'
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status,
          approval_status = 'approved',
          notes = EXCLUDED.notes,
          marked_by = auth.uid(),
          reviewed_by = auth.uid(),
          reviewed_at = v_now,
          attendance_source = COALESCE(public.attendance_records.attendance_source, 'day_status')
      RETURNING id INTO v_id;
      PERFORM public.attendance_set_write_context('normal');

      SELECT to_jsonb(ar) INTO v_after FROM public.attendance_records ar WHERE ar.id = v_id;
      INSERT INTO public.attendance_corrections_audit (
        company_id, attendance_record_id, target_user_id, actor_user_id,
        reason, before, after, kind
      ) VALUES (
        v_me.company_id, v_id, p_user_id, auth.uid(),
        NULLIF(trim(p_notes), ''), v_before, v_after, 'day_status'
      );
    END IF;

    PERFORM public.create_system_notification(
        p_user_id,
        'Attendance Recorded',
        'Your attendance for ' || p_date::TEXT || ' was marked as ' || p_status::TEXT || '.',
        'info'::notification_type
    );
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Closers use shared window end (R9)
CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
    p_user_id UUID,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_out TIMESTAMPTZ;
    v_last TIMESTAMPTZ;
    n INTEGER := 0;
    v_total INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR r IN
        SELECT *
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, v_now) LIMIT 1;

        IF v_win.window_end_utc IS NULL OR COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date THEN
          SELECT * INTO v_win
          FROM public.attendance_window_for_user(
            p_user_id,
            (r.attendance_date + TIME '12:00') AT TIME ZONE COALESCE(
              (SELECT timezone FROM public.work_shifts ws WHERE ws.id = r.shift_id),
              public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id))
            )
          ) LIMIT 1;
        END IF;

        IF v_win.window_end_utc IS NULL OR v_now <= v_win.window_end_utc THEN
            CONTINUE;
        END IF;

        SELECT COALESCE(MAX(d.last_presence_at), MAX(vs.clock_in_at), r.clock_in_at)
        INTO v_last
        FROM public.attendance_visit_segments vs
        FULL OUTER JOIN public.attendance_devices d
          ON d.user_id = p_user_id AND d.revoked_at IS NULL
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = r.attendance_date
          AND vs.clock_out_at IS NULL;

        v_out := LEAST(COALESCE(v_last, v_win.window_end_utc), v_win.window_end_utc);
        v_out := GREATEST(r.clock_in_at, v_out);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%window end%' THEN notes
                ELSE COALESCE(notes, '') || ' | Closed (window end)'
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF NOT EXISTS (
            SELECT 1 FROM public.attendance_visit_segments
            WHERE user_id = p_user_id AND attendance_date = r.attendance_date
        ) THEN
            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_out_at, work_minutes, notes
            ) VALUES (
                p_user_id, r.id, r.attendance_date, 1,
                r.clock_in_at, v_out,
                GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
                'Auto clock-out (window end)'
            );
        END IF;

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        UPDATE public.attendance_records SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%window end%' THEN notes
                ELSE COALESCE(notes, '') || ' | Auto clock-out (window end)'
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public.touch_my_presence();
    RETURN public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_all_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.attendance_close_ended_windows();
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v1 INTEGER;
  v2 INTEGER;
BEGIN
  v1 := public.attendance_close_ended_windows();
  v2 := public.attendance_close_stale_presence();
  RETURN v1 + v2;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_hybrid_remote_day(DATE, public.attendance_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_all_ended_shift_attendance() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_ended_shift_attendance() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
