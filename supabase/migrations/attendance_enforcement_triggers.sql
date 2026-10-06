-- attendance_enforcement_triggers.sql
-- R16–R17 / C: reject NEW clock time writes outside W unless correction/leave/day_status context.
-- Historical rows are never rewritten by this migration.

CREATE OR REPLACE FUNCTION public.attendance_guard_clock_times()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode TEXT := public.attendance_write_mode();
  v_win RECORD;
  v_at TIMESTAMPTZ;
BEGIN
  -- Allow audited correction, leave day-status, and day_status supervisor marks
  IF v_mode IN ('admin_correction', 'leave', 'day_status') THEN
    RETURN NEW;
  END IF;

  -- Only care when clock times are introduced or changed
  IF TG_TABLE_NAME = 'attendance_records' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_in_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_out_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'attendance_visit_segments' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_in_at % not inside W', v_at;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_out_at % not inside W', v_at;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_records_window_guard ON public.attendance_records;
CREATE TRIGGER trg_attendance_records_window_guard
  BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at
  ON public.attendance_records
  FOR EACH ROW
  EXECUTE PROCEDURE public.attendance_guard_clock_times();

DROP TRIGGER IF EXISTS trg_attendance_visits_window_guard ON public.attendance_visit_segments;
CREATE TRIGGER trg_attendance_visits_window_guard
  BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at
  ON public.attendance_visit_segments
  FOR EACH ROW
  EXECUTE PROCEDURE public.attendance_guard_clock_times();

-- Reject location pings outside W (N3)
CREATE OR REPLACE FUNCTION public.employee_location_pings_window_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_at TIMESTAMPTZ := COALESCE(NEW.recorded_at, timezone('utc', now()));
BEGIN
  SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RAISE EXCEPTION 'location_ping_outside_window';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_location_pings_window ON public.employee_location_pings;
CREATE TRIGGER trg_employee_location_pings_window
  BEFORE INSERT ON public.employee_location_pings
  FOR EACH ROW
  EXECUTE PROCEDURE public.employee_location_pings_window_guard();

NOTIFY pgrst, 'reload schema';
