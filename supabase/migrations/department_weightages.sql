-- Department weightages + auto KPI weight by department & work assigned

CREATE TABLE IF NOT EXISTS public.departments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    org_weight_pct  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (org_weight_pct >= 0 AND org_weight_pct <= 100),
    active          BOOLEAN NOT NULL DEFAULT true,
    is_demo         BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (name),
    UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_departments_active ON public.departments(active) WHERE active = true;

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kpis_department_id ON public.kpis(department_id);

-- Seed default departments (percentages sum to 100)
INSERT INTO public.departments (name, slug, org_weight_pct, is_demo) VALUES
    ('Graphics', 'graphics', 12.00, false),
    ('IT', 'it', 16.00, false),
    ('Marketing', 'marketing', 16.00, false),
    ('SEO', 'seo', 12.00, false),
    ('Operations', 'operations', 16.00, false),
    ('HR', 'hr', 10.00, false),
    ('Business Development', 'business-development', 18.00, false)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    org_weight_pct = EXCLUDED.org_weight_pct,
    active = true;

-- Link existing KPIs to departments by name
UPDATE public.kpis k
SET department_id = d.id
FROM public.departments d
WHERE k.department_id IS NULL
  AND lower(trim(k.department)) = lower(trim(d.name));

CREATE OR REPLACE FUNCTION public.can_manage_departments()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid()
          AND u.role IN ('admin'::public.user_role, 'manager'::public.user_role)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_departments()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    org_weight_pct NUMERIC,
    active BOOLEAN,
    kpi_count BIGINT,
    active_kpi_count BIGINT
) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    RETURN QUERY
    SELECT
        d.id,
        d.name,
        d.slug,
        d.org_weight_pct,
        d.active,
        COUNT(k.id) AS kpi_count,
        COUNT(k.id) FILTER (WHERE k.completion_status = 'pending') AS active_kpi_count
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
    WHERE d.active = true
    GROUP BY d.id
    ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_department_weight_summary()
RETURNS TABLE(total_pct NUMERIC, department_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(d.org_weight_pct), 0)::NUMERIC,
        COUNT(*)::BIGINT
    FROM public.departments d
    WHERE d.active = true;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_department(
    p_name TEXT,
    p_weight_pct NUMERIC,
    p_department_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_slug TEXT;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can manage departments';
    END IF;

    IF p_weight_pct < 0 OR p_weight_pct > 100 THEN
        RAISE EXCEPTION 'Weight must be between 0 and 100';
    END IF;

    v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);

    IF p_department_id IS NULL THEN
        INSERT INTO public.departments (name, slug, org_weight_pct, created_by, is_demo)
        VALUES (
            trim(p_name),
            v_slug,
            p_weight_pct,
            v_uid,
            public.is_demo_user(v_uid)
        )
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            org_weight_pct = EXCLUDED.org_weight_pct,
            updated_at = timezone('utc'::text, now())
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.departments SET
            name = trim(p_name),
            org_weight_pct = p_weight_pct,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_department_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Department not found'; END IF;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.save_department_weightages(
    p_weights JSONB
)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_pct NUMERIC;
    v_name TEXT;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can set department weightages';
    END IF;

    IF p_weights IS NULL OR jsonb_array_length(p_weights) = 0 THEN
        RAISE EXCEPTION 'No department weights provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_weights)
    LOOP
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_total := v_total + v_pct;
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_weights)
    LOOP
        v_id := NULLIF(v_item->>'id', '')::UUID;
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');

        IF v_id IS NOT NULL THEN
            UPDATE public.departments SET
                org_weight_pct = v_pct,
                name = COALESCE(NULLIF(v_name, ''), name),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id;
        ELSIF v_name <> '' THEN
            PERFORM public.upsert_department(v_name, v_pct, NULL);
        END IF;
    END LOOP;

    -- Rebalance all pending KPI weights org-wide
    PERFORM public.rebalance_all_kpi_weights();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.deactivate_department(p_department_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can manage departments';
    END IF;
    UPDATE public.departments SET active = false, updated_at = timezone('utc'::text, now())
    WHERE id = p_department_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- KPI work-days for duration-based split
CREATE OR REPLACE FUNCTION public.kpi_work_days(p_start DATE, p_end DATE)
RETURNS INTEGER AS $$
BEGIN
    IF p_start IS NULL OR p_end IS NULL THEN RETURN 30; END IF;
    RETURN GREATEST(1, (p_end - p_start) + 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Auto weight: department % × share of work (days) within department
CREATE OR REPLACE FUNCTION public.calculate_kpi_weight(
    p_user_id UUID,
    p_department_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_exclude_kpi_id UUID DEFAULT NULL
)
RETURNS NUMERIC AS $$
DECLARE
    v_dept_pct NUMERIC;
    v_new_days INTEGER;
    v_total_days NUMERIC := 0;
    v_weight NUMERIC;
    rec RECORD;
BEGIN
    SELECT org_weight_pct INTO v_dept_pct
    FROM public.departments
    WHERE id = p_department_id AND active = true;

    IF v_dept_pct IS NULL THEN
        SELECT 100.0 / GREATEST(COUNT(*), 1) INTO v_dept_pct
        FROM public.departments WHERE active = true;
    END IF;

    v_new_days := public.kpi_work_days(p_start_date, p_end_date);

    FOR rec IN
        SELECT k.id, k.start_date, k.end_date
        FROM public.kpis k
        WHERE k.user_id = p_user_id
          AND k.completion_status = 'pending'
          AND k.department_id = p_department_id
          AND (p_exclude_kpi_id IS NULL OR k.id <> p_exclude_kpi_id)
    LOOP
        v_total_days := v_total_days + public.kpi_work_days(rec.start_date, rec.end_date);
    END LOOP;

    v_total_days := v_total_days + v_new_days;

    IF v_total_days <= 0 THEN
        v_total_days := v_new_days;
    END IF;

    -- Scale: dept importance (0-100) → base multiplier up to 10, split by work days
    v_weight := (v_dept_pct / 100.0) * 10.0 * (v_new_days::NUMERIC / v_total_days);
    RETURN GREATEST(0.25, LEAST(10.0, ROUND(v_weight, 2)));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.rebalance_user_kpi_weights(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
    rec RECORD;
    v_dept UUID;
    v_total_days NUMERIC;
    v_days INTEGER;
    v_dept_pct NUMERIC;
    v_weight NUMERIC;
BEGIN
    FOR v_dept IN
        SELECT DISTINCT k.department_id
        FROM public.kpis k
        WHERE k.user_id = p_user_id
          AND k.completion_status = 'pending'
          AND k.department_id IS NOT NULL
    LOOP
        SELECT org_weight_pct INTO v_dept_pct
        FROM public.departments WHERE id = v_dept;

        SELECT COALESCE(SUM(public.kpi_work_days(k.start_date, k.end_date)), 1)
        INTO v_total_days
        FROM public.kpis k
        WHERE k.user_id = p_user_id
          AND k.completion_status = 'pending'
          AND k.department_id = v_dept;

        FOR rec IN
            SELECT k.id, k.start_date, k.end_date
            FROM public.kpis k
            WHERE k.user_id = p_user_id
              AND k.completion_status = 'pending'
              AND k.department_id = v_dept
        LOOP
            v_days := public.kpi_work_days(rec.start_date, rec.end_date);
            v_weight := (COALESCE(v_dept_pct, 10) / 100.0) * 10.0 * (v_days::NUMERIC / v_total_days);
            v_weight := GREATEST(0.25, LEAST(10.0, ROUND(v_weight, 2)));

            UPDATE public.kpis SET weight = v_weight, updated_at = now()
            WHERE id = rec.id;
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.rebalance_all_kpi_weights()
RETURNS VOID AS $$
DECLARE
    v_user UUID;
BEGIN
    FOR v_user IN
        SELECT DISTINCT user_id FROM public.kpis
        WHERE completion_status = 'pending' AND department_id IS NOT NULL
    LOOP
        PERFORM public.rebalance_user_kpi_weights(v_user);
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Resolve department by id or name
CREATE OR REPLACE FUNCTION public.resolve_department_id(p_department TEXT)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_department IS NULL OR trim(p_department) = '' THEN RETURN NULL; END IF;

    IF p_department ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT id INTO v_id FROM public.departments WHERE id = p_department::UUID AND active = true;
        IF FOUND THEN RETURN v_id; END IF;
    END IF;

    SELECT id INTO v_id FROM public.departments
    WHERE active = true AND lower(trim(name)) = lower(trim(p_department))
    LIMIT 1;

    IF FOUND THEN RETURN v_id; END IF;

    SELECT id INTO v_id FROM public.departments
    WHERE active = true AND slug = lower(regexp_replace(trim(p_department), '[^a-zA-Z0-9]+', '-', 'g'))
    LIMIT 1;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE);
DROP FUNCTION IF EXISTS public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC);

CREATE OR REPLACE FUNCTION public.assign_kpi_manager(
    p_employee_id UUID,
    p_department TEXT,
    p_description TEXT,
    p_start_date DATE,
    p_end_date DATE,
    p_weight NUMERIC DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_weight NUMERIC) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    v_dept_id := public.resolve_department_id(p_department);

    IF v_dept_id IS NULL THEN
        RAISE EXCEPTION 'Unknown department. Select from configured departments list.';
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    IF p_weight IS NOT NULL THEN
        IF p_weight < 0.25 OR p_weight > 10 THEN
            RAISE EXCEPTION 'KPI weight must be between 0.25 and 10';
        END IF;
        v_weight := ROUND(p_weight, 2);
    ELSE
        v_weight := public.calculate_kpi_weight(p_employee_id, v_dept_id, p_start_date, p_end_date, NULL);
    END IF;

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category,
        start_date, end_date, target_value, current_value, weight, direction, status, completion_status, redo_count
    ) VALUES (
        p_employee_id, v_dept_name, p_description, v_dept_name, v_dept_id, v_dept_name,
        p_start_date, p_end_date, 100, 0, v_weight, 'higher_better', 'at_risk', 'pending', 0
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI Assigned',
        'Your manager assigned a KPI in ' || v_dept_name || '. Due by ' || p_end_date::TEXT
            || '. Weight: ' || v_weight::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_id := v_kpi_id;
    kpi_weight := v_weight;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC) TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_departments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_department_weight_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_department(TEXT, NUMERIC, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_department_weightages(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_department(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_kpi_weight(UUID, UUID, DATE, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_user_kpi_weights(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_all_kpi_weights() TO authenticated;
