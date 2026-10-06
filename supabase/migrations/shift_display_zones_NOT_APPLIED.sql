-- APPLIED on production 2026-10-06 (after staging).
-- R76–R80: multi-zone shift display + office defaults + remove Karachi-as-global-default.
-- Effective attendance window still uses work_shifts.timezone (MAIN) only.
--
-- SAFETY (Section O):
-- 1) Backfill companies.timezone = Asia/Karachi for every existing company BEFORE
--    app_timezone() falls back to UTC, so no existing attendance_date changes.
-- 2) Keep OLD upsert_work_shift call shape working (single function with defaulted
--    p_timezone / p_display_zones) so the currently deployed web app can still save.
-- 3) New registration UI requires timezone; handle_new_user falls back to
--    Asia/Karachi (logged) when metadata omits it so the live website keeps working.

-- ============================================================================
-- 0) Snapshot + backfill company timezones (current behaviour = Asia/Karachi)
-- ============================================================================
DROP TABLE IF EXISTS public._section_o_att_dates_before;
CREATE TABLE public._section_o_att_dates_before AS
SELECT id, user_id, attendance_date FROM public.attendance_records;

UPDATE public.companies
SET timezone = 'Asia/Karachi'
WHERE timezone IS NULL OR btrim(timezone) = '';

-- Prove: no company has NULL / blank timezone after backfill
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.companies
  WHERE timezone IS NULL OR btrim(timezone) = '';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Section O abort: % companies still missing timezone after backfill', v_bad;
  END IF;
END;
$$;

ALTER TABLE public.companies
  ALTER COLUMN timezone SET NOT NULL;

-- ============================================================================
-- shift_display_zones
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.shift_display_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES public.work_shifts(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  entered_start_time TIME NOT NULL,
  entered_end_time TIME NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (shift_id, timezone)
);

CREATE INDEX IF NOT EXISTS idx_shift_display_zones_shift ON public.shift_display_zones(shift_id);

ALTER TABLE public.shift_display_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shift_display_zones_select ON public.shift_display_zones;
CREATE POLICY shift_display_zones_select ON public.shift_display_zones
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.work_shifts ws
      JOIN public.users m ON m.id = ws.manager_id
      JOIN public.users me ON me.id = auth.uid()
      WHERE ws.id = shift_id
        AND (me.company_id = m.company_id OR me.is_platform_owner)
    )
  );

DROP POLICY IF EXISTS shift_display_zones_write ON public.shift_display_zones;
CREATE POLICY shift_display_zones_write ON public.shift_display_zones
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

-- ============================================================================
-- Office GPS default zones (R80)
-- ============================================================================
ALTER TABLE public.office_locations
  ADD COLUMN IF NOT EXISTS default_timezone TEXT,
  ADD COLUMN IF NOT EXISTS default_display_timezones TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================================
-- Company / shift timezone: stop forcing Asia/Karachi as DEFAULT for NEW rows.
-- Existing rows already backfilled above.
-- ============================================================================
ALTER TABLE public.companies
  ALTER COLUMN timezone DROP DEFAULT;

ALTER TABLE public.work_shifts
  ALTER COLUMN timezone DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.company_timezone(p_company_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(btrim(c.timezone), '')
  FROM public.companies c
  WHERE c.id = p_company_id;
$$;

-- app_timezone(): prefer authenticated user's company TZ; UTC only as last resort
-- (safe because every existing company was backfilled to Asia/Karachi).
CREATE OR REPLACE FUNCTION public.app_timezone()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT public.company_timezone(u.company_id) INTO v_tz
  FROM public.users u
  WHERE u.id = auth.uid();
  RETURN COALESCE(NULLIF(btrim(v_tz), ''), 'UTC');
END;
$$;

-- ============================================================================
-- Upsert shift: extend LIVE signature with optional timezone + display zones.
-- Drop the old 8-arg identity, recreate as 10-arg with defaults so OLD clients
-- (no p_timezone / p_display_zones) keep working unchanged.
-- ============================================================================
DROP FUNCTION IF EXISTS public.upsert_work_shift(text, time, time, integer[], integer, uuid, boolean, boolean);
-- Also drop any alternate overload from prior drafts (shift_id-first)
DROP FUNCTION IF EXISTS public.upsert_work_shift(uuid, text, time, time, integer[], integer, boolean, boolean);
DROP FUNCTION IF EXISTS public.upsert_work_shift(uuid, text, time, time, integer[], integer, boolean, boolean, text, jsonb);

CREATE OR REPLACE FUNCTION public.upsert_work_shift(
  p_name text,
  p_start_time time,
  p_end_time time,
  p_days_of_week integer[] DEFAULT ARRAY[1, 2, 3, 4, 5],
  p_grace_minutes integer DEFAULT 30,
  p_shift_id uuid DEFAULT NULL,
  p_crosses_midnight boolean DEFAULT NULL,
  p_apply_to_all boolean DEFAULT true,
  p_timezone text DEFAULT NULL,
  p_display_zones jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role_txt TEXT;
  v_id UUID;
  v_demo BOOLEAN;
  v_overnight BOOLEAN;
  v_company UUID;
  v_org BOOLEAN;
  v_tz TEXT;
  v_item JSONB;
  v_ord INT := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT role::text INTO v_role_txt FROM public.users WHERE id = v_uid;
  IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
    RAISE EXCEPTION 'Only managers, HR, and admins can manage shifts';
  END IF;

  v_org := public.can_manage_org_shifts(v_uid);
  v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

  IF NOT v_overnight AND p_end_time <= p_start_time THEN
    RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
  END IF;

  v_tz := NULLIF(btrim(COALESCE(p_timezone, '')), '');
  IF v_tz IS NOT NULL THEN
    PERFORM public.assert_valid_iana_timezone(v_tz);
  END IF;

  v_demo := public.is_demo_user(v_uid);
  PERFORM public.enforce_demo_isolation(v_uid);

  IF v_org AND NOT v_demo THEN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
  END IF;

  IF p_shift_id IS NULL THEN
    IF v_tz IS NULL THEN
      -- Old web clients omit p_timezone; inherit company TZ (backfilled Asia/Karachi).
      SELECT public.company_timezone(u.company_id) INTO v_tz
      FROM public.users u WHERE u.id = v_uid;
    END IF;
    IF v_tz IS NULL THEN
      RAISE EXCEPTION 'Shift timezone is required (set company timezone or pass p_timezone)';
    END IF;
    PERFORM public.assert_valid_iana_timezone(v_tz);

    INSERT INTO public.work_shifts (
      manager_id, name, start_time, end_time, days_of_week, grace_minutes,
      crosses_midnight, apply_to_all, is_demo, timezone
    ) VALUES (
      v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes,
      v_overnight, p_apply_to_all, v_demo, v_tz
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.work_shifts ws SET
      name = trim(p_name),
      start_time = p_start_time,
      end_time = p_end_time,
      days_of_week = p_days_of_week,
      grace_minutes = p_grace_minutes,
      crosses_midnight = v_overnight,
      apply_to_all = p_apply_to_all,
      timezone = COALESCE(v_tz, timezone),
      updated_at = timezone('utc'::text, now())
    WHERE ws.id = p_shift_id
      AND (
        ws.manager_id = v_uid
        OR (
          v_org
          AND EXISTS (
            SELECT 1 FROM public.users owner
            WHERE owner.id = ws.manager_id
              AND (
                (v_demo AND owner.is_demo = true)
                OR (NOT v_demo AND owner.company_id = v_company)
              )
          )
        )
      )
    RETURNING ws.id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    SELECT timezone INTO v_tz FROM public.work_shifts WHERE id = v_id;
  END IF;

  -- Display zones (no-op when old client omits p_display_zones → default [])
  DELETE FROM public.shift_display_zones WHERE shift_id = v_id;
  IF p_display_zones IS NOT NULL AND jsonb_typeof(p_display_zones) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_display_zones)
    LOOP
      IF NULLIF(btrim(v_item->>'timezone'), '') IS NULL THEN CONTINUE; END IF;
      IF NULLIF(btrim(v_item->>'timezone'), '') IS NOT DISTINCT FROM v_tz THEN CONTINUE; END IF;
      PERFORM public.assert_valid_iana_timezone(v_item->>'timezone');
      INSERT INTO public.shift_display_zones (shift_id, timezone, entered_start_time, entered_end_time, sort_order)
      VALUES (
        v_id,
        v_item->>'timezone',
        (v_item->>'start')::TIME,
        (v_item->>'end')::TIME,
        COALESCE((v_item->>'sort_order')::INT, v_ord)
      );
      v_ord := v_ord + 1;
    END LOOP;
  END IF;

  IF p_apply_to_all AND v_role_txt = 'manager' THEN
    BEGIN
      PERFORM public.assign_shift_to_all_team(v_id, CURRENT_DATE);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_work_shift(text, time, time, integer[], integer, uuid, boolean, boolean, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_shift_display_zones(p_shift_id UUID)
RETURNS TABLE (
  timezone TEXT,
  entered_start_time TIME,
  entered_end_time TIME,
  sort_order INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT z.timezone, z.entered_start_time, z.entered_end_time, z.sort_order
  FROM public.shift_display_zones z
  WHERE z.shift_id = p_shift_id
  ORDER BY z.sort_order, z.timezone;
$$;

GRANT EXECUTE ON FUNCTION public.list_shift_display_zones(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_shift_display_changes_within_days(p_days INT DEFAULT 7)
RETURNS TABLE (
  shift_id UUID,
  shift_name TEXT,
  main_timezone TEXT,
  display_timezone TEXT,
  change_on DATE,
  note TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_shift_display_changes_within_days(INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_office_default_timezones(
  p_office_id UUID,
  p_default_timezone TEXT,
  p_default_display_timezones TEXT[] DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_default_timezone IS NOT NULL AND btrim(p_default_timezone) <> '' THEN
    PERFORM public.assert_valid_iana_timezone(p_default_timezone);
  END IF;
  UPDATE public.office_locations o SET
    default_timezone = NULLIF(btrim(p_default_timezone), ''),
    default_display_timezones = COALESCE(p_default_display_timezones, '{}'),
    updated_at = timezone('utc', now())
  WHERE o.id = p_office_id
    AND (
      o.company_id = (SELECT company_id FROM public.users WHERE id = v_uid)
      OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_uid AND u.is_platform_owner)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_office_default_timezones(UUID, TEXT, TEXT[]) TO authenticated;

COMMENT ON TABLE public.shift_display_zones IS
  'R77: Extra office times for display only. Attendance window follows work_shifts.timezone (main).';

DROP FUNCTION IF EXISTS public.get_manager_shifts();

CREATE OR REPLACE FUNCTION public.get_manager_shifts()
RETURNS TABLE(
    id UUID,
    name TEXT,
    start_time TIME,
    end_time TIME,
    days_of_week INTEGER[],
    grace_minutes INTEGER,
    active BOOLEAN,
    crosses_midnight BOOLEAN,
    apply_to_all BOOLEAN,
    assigned_count BIGINT,
    timezone TEXT
) AS $$
#variable_conflict use_column
DECLARE
    v_uid UUID := auth.uid();
    v_role_txt TEXT;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role::text INTO v_role_txt FROM public.users u WHERE u.id = v_uid;
    IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
        RAISE EXCEPTION 'Managers, HR, and admins only';
    END IF;

    IF public.can_manage_org_shifts(v_uid) AND NOT public.is_demo_user(v_uid) THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

        RETURN QUERY
        SELECT
            ws.id, ws.name, ws.start_time, ws.end_time, ws.days_of_week, ws.grace_minutes,
            ws.active, ws.crosses_midnight, ws.apply_to_all,
            (
                SELECT COUNT(*)::BIGINT
                FROM public.employee_shift_assignments esa
                WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
            ) AS assigned_count,
            ws.timezone
        FROM public.work_shifts ws
        JOIN public.users owner ON owner.id = ws.manager_id
        WHERE owner.company_id = v_company AND ws.active = true AND COALESCE(ws.is_demo, false) = false
        ORDER BY ws.name;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        ws.id, ws.name, ws.start_time, ws.end_time, ws.days_of_week, ws.grace_minutes,
        ws.active, ws.crosses_midnight, ws.apply_to_all,
        (
            SELECT COUNT(*)::BIGINT
            FROM public.employee_shift_assignments esa
            WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
        ) AS assigned_count,
        ws.timezone
    FROM public.work_shifts ws
    WHERE ws.manager_id = v_uid AND ws.active = true
    ORDER BY ws.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_manager_shifts() TO authenticated;

-- ============================================================================
-- Registration: require company timezone from signup metadata
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
    v_company_name TEXT;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_role public.user_role;
    v_company_id_meta UUID;
    v_manager_id UUID;
    v_dept_id_meta UUID;
    v_job_title TEXT;
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
    v_tz TEXT;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;
    v_manager_id := NULLIF(NEW.raw_user_meta_data->>'manager_id', '')::UUID;
    v_dept_id_meta := NULLIF(NEW.raw_user_meta_data->>'department_id', '')::UUID;
    v_job_title := NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'job_title', '')), '');

    IF NEW.raw_user_meta_data->>'registration_type' = 'company' THEN
        v_company_name := trim(coalesce(NEW.raw_user_meta_data->>'company_name', 'New Company'));
        v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'));
        v_slug := trim(both '-' from v_slug) || '-' || substr(replace(NEW.id::text, '-', ''), 1, 8);

        v_tz := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'timezone', '')), '');
        IF v_tz IS NULL THEN
            -- Deployed website may omit timezone until the new registration UI ships.
            -- Keep current production behaviour (Asia/Karachi) and log the fallback.
            v_tz := 'Asia/Karachi';
            RAISE LOG 'handle_new_user: company "%" registered without timezone metadata; defaulting to Asia/Karachi',
              v_company_name;
        END IF;
        PERFORM public.assert_valid_iana_timezone(v_tz);

        BEGIN
            v_sub := coalesce(
                NULLIF(trim(NEW.raw_user_meta_data->>'subscription_plan'), '')::public.subscription_plan,
                'trial'::public.subscription_plan
            );
        EXCEPTION WHEN OTHERS THEN
            v_sub := 'trial'::public.subscription_plan;
        END;

        INSERT INTO public.companies (
            name, slug, status, contact_email, contact_name, contact_phone,
            job_title, industry, employee_count, website,
            address_line, city, country, subscription_plan, registration_notes,
            owner_user_id, trial_ends_at, approved_at, timezone
        )
        VALUES (
            v_company_name, v_slug, 'pending', NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'job_title'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'industry'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'employee_count'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'website'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'address_line'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'city'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'country'), ''),
            v_sub,
            NULLIF(trim(NEW.raw_user_meta_data->>'notes'), ''),
            NULL,
            NULL,
            NULL,
            v_tz
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        UPDATE public.companies SET owner_user_id = NEW.id WHERE id = v_company_id;

        v_notify_msg :=
            v_company_name || ' requested access. Admin: '
            || coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email)
            || E'\nEmail: ' || NEW.email
            || coalesce(E'\nPhone: ' || NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''), '')
            || coalesce(E'\nIndustry: ' || NULLIF(trim(NEW.raw_user_meta_data->>'industry'), ''), '')
            || coalesce(E'\nTeam size: ' || NULLIF(trim(NEW.raw_user_meta_data->>'employee_count'), ''), '')
            || E'\nTimezone: ' || v_tz
            || E'\nApprove in Registered Companies / Platform dashboard.';

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company registration — ' || v_company_name, v_notify_msg);

        INSERT INTO public.notifications (user_id, title, message, type)
        VALUES (
            NEW.id,
            'Registration received',
            'Thanks for registering ' || v_company_name || '. Your organization is pending approval by the platform owner (info@walfia.ai). You will get access as soon as it is approved.',
            'info'
        );

        INSERT INTO public.departments (name, slug, org_weight_pct, company_id, active, is_demo)
        VALUES ('General', 'general-' || substr(replace(v_company_id::text, '-', ''), 1, 8), 100.00, v_company_id, true, false)
        RETURNING id INTO v_dept_id;

        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'seed_default_department_kpis'
        ) THEN
            PERFORM public.seed_default_department_kpis(v_dept_id);
        END IF;

        RETURN NEW;
    END IF;

    IF lower(NEW.email) = lower(public.platform_owner_email()) THEN
        INSERT INTO public.users (id, email, full_name, role, is_platform_owner, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', 'Samiya Kayani'), 'admin', true, false);
        RETURN NEW;
    END IF;

    IF NEW.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
       OR (NEW.raw_user_meta_data->>'is_demo')::boolean IS true THEN
        INSERT INTO public.users (id, email, full_name, role, is_demo, demo_expires_at)
        VALUES (
            NEW.id, NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            v_role, true,
            timezone('utc'::text, now()) + interval '3 days'
        );
        RETURN NEW;
    END IF;

    IF v_company_id_meta IS NULL THEN
        RAISE EXCEPTION 'Company is required to create a user';
    END IF;

    IF v_role IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        IF v_dept_id_meta IS NULL THEN
            RAISE EXCEPTION 'Department is required for employees and managers';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = v_dept_id_meta
              AND d.company_id = v_company_id_meta
              AND COALESCE(d.active, true)
        ) THEN
            RAISE EXCEPTION 'Department must belong to the same company';
        END IF;
    ELSIF v_role = 'hr'::public.user_role THEN
        v_dept_id_meta := NULL;
        IF v_manager_id IS NULL THEN
            RAISE EXCEPTION 'HR must report to a company admin';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.users m
            WHERE m.id = v_manager_id
              AND m.role = 'admin'::public.user_role
              AND m.company_id = v_company_id_meta
        ) THEN
            RAISE EXCEPTION 'HR must report to a company admin';
        END IF;
    ELSE
        v_dept_id_meta := NULL;
        v_manager_id := NULL;
        v_job_title := NULL;
    END IF;

    INSERT INTO public.users (id, email, full_name, role, company_id, department_id, manager_id, job_title, is_demo)
    VALUES (
        NEW.id, NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role, v_company_id_meta,
        v_dept_id_meta,
        v_manager_id,
        v_job_title,
        false
    );

    RETURN NEW;
END;
$$;

-- ============================================================================
-- Test: attendance_date identical before vs after (this migration must not rewrite dates)
-- ============================================================================
DO $$
DECLARE
  v_changed INT;
BEGIN
  SELECT count(*) INTO v_changed
  FROM public.attendance_records a
  JOIN public._section_o_att_dates_before b ON b.id = a.id
  WHERE a.attendance_date IS DISTINCT FROM b.attendance_date;

  IF v_changed > 0 THEN
    RAISE EXCEPTION 'Section O abort: % attendance_records changed attendance_date', v_changed;
  END IF;
END;
$$;

DROP TABLE IF EXISTS public._section_o_att_dates_before;
