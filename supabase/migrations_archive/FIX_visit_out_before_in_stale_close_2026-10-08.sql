-- Fix: R69 / stale-presence close writing clock_out before a later visit's clock_in.
-- Race: leave at T1 (last_presence=T1) → geo/manual re-enter at T2>T1 opens a new visit
-- → cron closes open visit with out=T1 < in=T2, and sticks attendance_records.clock_out at T1.
-- Also repairs existing inverted visit rows and syncs parent clock_out to max valid visit out.

-- Guard: never persist out-before-in on visit segments
CREATE OR REPLACE FUNCTION public.trg_attendance_visit_out_after_in()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.clock_in_at IS NOT NULL
     AND NEW.clock_out_at IS NOT NULL
     AND NEW.clock_out_at < NEW.clock_in_at THEN
    NEW.clock_out_at := NULL;
    NEW.work_minutes := NULL;
    NEW.notes := CASE
      WHEN COALESCE(NEW.notes, '') ILIKE '%Rejected out-before-in%' THEN NEW.notes
      ELSE TRIM(BOTH FROM COALESCE(NEW.notes, '') || ' | Rejected out-before-in')
    END;
  ELSIF NEW.clock_in_at IS NOT NULL AND NEW.clock_out_at IS NOT NULL THEN
    NEW.work_minutes := GREATEST(
      0,
      (EXTRACT(EPOCH FROM (NEW.clock_out_at - NEW.clock_in_at)) / 60)::INTEGER
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_visit_out_after_in ON public.attendance_visit_segments;
CREATE TRIGGER trg_attendance_visit_out_after_in
BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at, work_minutes
ON public.attendance_visit_segments
FOR EACH ROW
EXECUTE PROCEDURE public.trg_attendance_visit_out_after_in();

-- Stale close: skip when an open visit started after last device presence;
-- never close a visit with out < in; only close parent when no open visits remain.
CREATE OR REPLACE FUNCTION public.attendance_close_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
  v_any_present BOOLEAN;
  v_out TIMESTAMPTZ;
  v_has_open BOOLEAN;
  v_local_time TEXT;
  v_tz TEXT;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_source IN ('auto_gps', 'auto_wifi', 'auto_laptop')
      AND EXISTS (
        SELECT 1
        FROM public.attendance_devices d
        WHERE d.user_id = ar.user_id
          AND d.revoked_at IS NULL
      )
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = r.user_id
        AND d.revoked_at IS NULL
        AND d.presence_state = 'present'
        AND (
          (d.platform IN ('windows', 'linux') AND d.last_heartbeat_at > v_now - INTERVAL '15 minutes')
          OR (d.platform IN ('android', 'ios') AND d.last_presence_at > v_now - INTERVAL '15 minutes')
        )
    ) INTO v_any_present;

    IF v_any_present THEN
      CONTINUE;
    END IF;

    SELECT GREATEST(
      (SELECT MAX(d.last_presence_at) FROM public.attendance_devices d
       WHERE d.user_id = r.user_id AND d.revoked_at IS NULL),
      (SELECT MAX(d.last_heartbeat_at) FROM public.attendance_devices d
       WHERE d.user_id = r.user_id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux'))
    ) INTO v_last;

    IF v_last IS NULL OR v_last > v_now - INTERVAL '15 minutes' THEN
      CONTINUE;
    END IF;

    v_last := LEAST(v_last, COALESCE(v_win.window_end_utc, v_last));

    -- Geo/manual re-enter after device left: open visit is newer than last presence.
    IF EXISTS (
      SELECT 1
      FROM public.attendance_visit_segments vs
      WHERE vs.user_id = r.user_id
        AND vs.attendance_date = r.attendance_date
        AND vs.clock_out_at IS NULL
        AND vs.clock_in_at > v_last
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.attendance_visit_segments SET
      clock_out_at = GREATEST(clock_in_at, v_last),
      work_minutes = GREATEST(
        0,
        (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_last) - clock_in_at)) / 60)::INTEGER
      ),
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Auto close: 15m no presence%' THEN notes
        ELSE COALESCE(notes, '') || ' | Auto close: 15m no presence (leave unconfirmed)'
      END
    WHERE user_id = r.user_id
      AND attendance_date = r.attendance_date
      AND clock_out_at IS NULL
      AND clock_in_at <= v_last;

    SELECT EXISTS (
      SELECT 1
      FROM public.attendance_visit_segments vs
      WHERE vs.user_id = r.user_id
        AND vs.attendance_date = r.attendance_date
        AND vs.clock_out_at IS NULL
    ) INTO v_has_open;

    IF v_has_open THEN
      CONTINUE;
    END IF;

    SELECT MAX(vs.clock_out_at)
    INTO v_out
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = r.user_id
      AND vs.attendance_date = r.attendance_date
      AND vs.clock_out_at IS NOT NULL
      AND vs.clock_out_at >= vs.clock_in_at;

    v_out := COALESCE(v_out, GREATEST(r.clock_in_at, v_last));
    v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_out);

    UPDATE public.attendance_records SET
      clock_out_at = v_out,
      work_minutes = v_mins,
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Auto close: 15m no presence%' THEN notes
        ELSE COALESCE(notes, '') || ' | Auto close: 15m no presence (leave unconfirmed)'
      END
    WHERE id = r.id;

    BEGIN
      SELECT COALESCE(
        (SELECT d.device_timezone FROM public.attendance_devices d
         WHERE d.user_id = r.user_id AND d.revoked_at IS NULL
         ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 1),
        c.timezone,
        'UTC'
      )
      INTO v_tz
      FROM public.users u
      JOIN public.companies c ON c.id = u.company_id
      WHERE u.id = r.user_id;

      v_local_time := trim(to_char(v_out AT TIME ZONE COALESCE(v_tz, 'UTC'), 'FMHH12:MI AM'));
    EXCEPTION WHEN OTHERS THEN
      v_local_time := NULL;
    END;

    BEGIN
      PERFORM public.create_system_notification(
        r.user_id,
        'Checked out',
        'Checked out at ' || COALESCE(v_local_time, '') || ' — you left the office.',
        'info'::public.notification_type,
        jsonb_build_object('kind', 'auto_checkout_grace', 'occurred_at', v_out)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;

-- Sanitize visit RPC: never return out-before-in; prefer live minutes for open visits
CREATE OR REPLACE FUNCTION public.get_my_attendance_visits(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    id UUID,
    visit_number INTEGER,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    work_minutes INTEGER,
    site_name TEXT,
    notes TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    RETURN QUERY
    SELECT
        vs.id,
        vs.visit_number,
        vs.clock_in_at,
        CASE
          WHEN vs.clock_out_at IS NOT NULL AND vs.clock_out_at >= vs.clock_in_at THEN vs.clock_out_at
          ELSE NULL
        END AS clock_out_at,
        CASE
            WHEN vs.clock_out_at IS NOT NULL AND vs.clock_out_at >= vs.clock_in_at THEN COALESCE(
                vs.work_minutes,
                GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::INTEGER)
            )
            WHEN vs.clock_out_at IS NULL OR vs.clock_out_at < vs.clock_in_at THEN
                GREATEST(0, (EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - vs.clock_in_at)) / 60)::INTEGER)
            ELSE 0
        END,
        vs.site_name,
        vs.notes
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = auth.uid()
      AND vs.attendance_date = p_date
    ORDER BY vs.visit_number ASC, vs.clock_in_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_visits(DATE) TO authenticated;

-- Repair existing inverted visits, then sync parent clock_out / work_minutes
DO $$
DECLARE
  rec RECORD;
  v_last_out TIMESTAMPTZ;
  v_open BOOLEAN;
  v_mins INTEGER;
BEGIN
  -- Bypass W-guard for historical repair (same GUC as admin corrections)
  PERFORM set_config('scorr.attendance_write_mode', 'admin_correction', true);

  UPDATE public.attendance_visit_segments
  SET clock_out_at = NULL,
      work_minutes = NULL,
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Cleared invalid out-before-in%' THEN notes
        ELSE TRIM(BOTH FROM COALESCE(notes, '') || ' | Cleared invalid out-before-in')
      END
  WHERE clock_out_at IS NOT NULL
    AND clock_in_at IS NOT NULL
    AND clock_out_at < clock_in_at;

  FOR rec IN
    SELECT ar.id, ar.user_id, ar.attendance_date, ar.clock_in_at, ar.clock_out_at
    FROM public.attendance_records ar
    WHERE EXISTS (
      SELECT 1 FROM public.attendance_visit_segments vs
      WHERE vs.user_id = ar.user_id AND vs.attendance_date = ar.attendance_date
    )
    -- Only repair rows that are inconsistent (open visit vs parent out, or out before last visit out)
    AND (
      EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = ar.user_id
          AND vs.attendance_date = ar.attendance_date
          AND vs.clock_out_at IS NULL
          AND ar.clock_out_at IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = ar.user_id
          AND vs.attendance_date = ar.attendance_date
          AND vs.clock_out_at IS NOT NULL
          AND vs.clock_out_at >= vs.clock_in_at
          AND (ar.clock_out_at IS NULL OR ar.clock_out_at < vs.clock_out_at)
      )
      OR (ar.clock_out_at IS NOT NULL AND ar.clock_in_at IS NOT NULL AND ar.clock_out_at < ar.clock_in_at)
    )
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_visit_segments vs
      WHERE vs.user_id = rec.user_id
        AND vs.attendance_date = rec.attendance_date
        AND vs.clock_out_at IS NULL
    ) INTO v_open;

    SELECT MAX(vs.clock_out_at)
    INTO v_last_out
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = rec.user_id
      AND vs.attendance_date = rec.attendance_date
      AND vs.clock_out_at IS NOT NULL
      AND vs.clock_out_at >= vs.clock_in_at;

    v_mins := public.attendance_day_total_minutes(rec.user_id, rec.attendance_date);

    IF v_open THEN
      UPDATE public.attendance_records
      SET clock_out_at = NULL,
          clock_out_lat = NULL,
          clock_out_lng = NULL,
          work_minutes = NULLIF(v_mins, 0)
      WHERE id = rec.id
        AND (clock_out_at IS NOT NULL OR work_minutes IS DISTINCT FROM NULLIF(v_mins, 0));
    ELSIF v_last_out IS NOT NULL AND (
      rec.clock_out_at IS NULL
      OR rec.clock_out_at IS DISTINCT FROM v_last_out
      OR (rec.clock_in_at IS NOT NULL AND rec.clock_out_at < rec.clock_in_at)
    ) THEN
      UPDATE public.attendance_records
      SET clock_out_at = v_last_out,
          work_minutes = NULLIF(v_mins, 0)
      WHERE id = rec.id;
    ELSE
      UPDATE public.attendance_records
      SET work_minutes = NULLIF(v_mins, 0)
      WHERE id = rec.id
        AND work_minutes IS DISTINCT FROM NULLIF(v_mins, 0);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
