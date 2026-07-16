-- Functional departments with predefined KPI indicators (weightages sum to 100% per department)

CREATE TABLE IF NOT EXISTS public.department_kpi_indicators (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id   UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    weight_pct      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (weight_pct >= 0 AND weight_pct <= 100),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (department_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dept_kpi_indicators_dept ON public.department_kpi_indicators(department_id);

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS indicator_id UUID REFERENCES public.department_kpi_indicators(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kpis_indicator_id ON public.kpis(indicator_id);

-- Replace generic departments with functional business departments (org weights = 25% each)
UPDATE public.departments SET active = false
WHERE slug IN ('graphics', 'it', 'marketing', 'seo', 'operations', 'hr', 'business-development');

INSERT INTO public.departments (name, slug, org_weight_pct, is_demo) VALUES
    ('Finance', 'finance', 25.00, false),
    ('Sales & Marketing', 'sales-marketing', 25.00, false),
    ('Human Resources', 'human-resources', 25.00, false),
    ('Operations & Supply Chain', 'operations-supply-chain', 25.00, false)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    org_weight_pct = EXCLUDED.org_weight_pct,
    active = true;

-- Seed KPI indicators per department (from KPI board template)
INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order)
SELECT d.id, v.name, v.description, v.weight_pct, v.sort_order
FROM public.departments d
CROSS JOIN (VALUES
    -- Finance (100%)
    ('finance', 'Budget Variance', 'Measures differences between projected and actual costs.', 30.00, 1),
    ('finance', 'Accounts Receivable Turnover', 'Tracks speed of client payments.', 30.00, 2),
    ('finance', 'Gross Profit Margin', 'Evaluates conversion of revenue to profit.', 20.00, 3),
    ('finance', 'Operating Cash Flow', 'Assesses cash generated versus required to sustain operations.', 20.00, 4),
    -- Sales & Marketing (100%)
    ('sales-marketing', 'Lead Conversion Rate', 'Percentage of leads that turn into customers.', 30.00, 1),
    ('sales-marketing', 'Customer Acquisition Cost (CAC)', 'Total marketing/sales spend divided by new customers.', 30.00, 2),
    ('sales-marketing', 'Monthly Sales Target / Volume', 'Actual revenue versus monthly quota.', 30.00, 3),
    ('sales-marketing', 'Customer Retention', 'Rate of retained customers or renewals.', 10.00, 4),
    -- Human Resources (100%)
    ('human-resources', 'Monthly Employee Turnover Rate', 'Percentage of staff leaving the organization.', 30.00, 1),
    ('human-resources', 'Time to Hire', 'Average days to fill an open position.', 30.00, 2),
    ('human-resources', 'Training & Development Hours', 'Average hours completed per employee.', 20.00, 3),
    ('human-resources', 'Employee Satisfaction (NPS)', 'Score reflecting workplace engagement.', 20.00, 4),
    -- Operations & Supply Chain (100%)
    ('operations-supply-chain', 'On-Time Delivery (OTD)', 'Orders delivered within the promised time frame.', 40.00, 1),
    ('operations-supply-chain', 'Defect or Error Rate', 'Percentage of products/services failing quality checks.', 30.00, 2),
    ('operations-supply-chain', 'Process Efficiency / Turnaround Time', 'Average time to complete a core service request.', 30.00, 3)
) AS v(slug, name, description, weight_pct, sort_order)
WHERE d.slug = v.slug AND d.active = true
ON CONFLICT (department_id, name) DO UPDATE SET
    description = EXCLUDED.description,
    weight_pct = EXCLUDED.weight_pct,
    sort_order = EXCLUDED.sort_order,
    active = true;

-- Get KPI indicators for a department
CREATE OR REPLACE FUNCTION public.get_department_kpi_indicators(p_department_id UUID DEFAULT NULL)
RETURNS TABLE(
    id UUID,
    department_id UUID,
    department_name TEXT,
    name TEXT,
    description TEXT,
    weight_pct NUMERIC,
    sort_order INTEGER
) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    RETURN QUERY
    SELECT
        i.id,
        i.department_id,
        d.name AS department_name,
        i.name,
        i.description,
        i.weight_pct,
        i.sort_order
    FROM public.department_kpi_indicators i
    JOIN public.departments d ON d.id = i.department_id
    WHERE i.active = true
      AND d.active = true
      AND (p_department_id IS NULL OR i.department_id = p_department_id)
    ORDER BY d.name, i.sort_order, i.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Save indicator weightages for one department (must sum to 100%)
CREATE OR REPLACE FUNCTION public.save_department_kpi_indicators(
    p_department_id UUID,
    p_indicators JSONB
)
RETURNS VOID AS $$
DECLARE
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can manage department KPIs';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_total := v_total + (v_item->>'weight_pct')::NUMERIC;
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department KPI weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_id := (v_item->>'id')::UUID;
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');
        v_desc := NULLIF(trim(v_item->>'description'), '');

        IF v_id IS NOT NULL THEN
            UPDATE public.department_kpi_indicators SET
                weight_pct = v_pct,
                name = COALESCE(NULLIF(v_name, ''), name),
                description = COALESCE(v_desc, description),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id AND department_id = p_department_id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Assign full department KPI board to an employee (all indicators with template weights)
CREATE OR REPLACE FUNCTION public.assign_department_kpi_board(
    p_employee_id UUID,
    p_department_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_count INTEGER, department_name TEXT) AS $$
DECLARE
    v_email TEXT;
    v_name TEXT;
    v_dept_name TEXT;
    v_count INTEGER := 0;
    rec RECORD;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    SELECT name INTO v_dept_name FROM public.departments
    WHERE id = p_department_id AND active = true;

    IF v_dept_name IS NULL THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    FOR rec IN
        SELECT i.id, i.name, i.description, i.weight_pct
        FROM public.department_kpi_indicators i
        WHERE i.department_id = p_department_id AND i.active = true
        ORDER BY i.sort_order, i.name
    LOOP
        INSERT INTO public.kpis (
            user_id, name, description, department, department_id, category,
            indicator_id, start_date, end_date, target_value, current_value,
            weight, direction, status, completion_status, redo_count
        ) VALUES (
            p_employee_id, rec.name,
            COALESCE(rec.description, '') || CASE WHEN p_notes IS NOT NULL AND trim(p_notes) <> '' THEN E'\n\nNotes: ' || p_notes ELSE '' END,
            v_dept_name, p_department_id, v_dept_name,
            rec.id, p_start_date, p_end_date, 100, 0,
            rec.weight_pct, 'higher_better', 'at_risk', 'pending', 0
        );

        v_count := v_count + 1;
    END LOOP;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'No KPI indicators configured for this department';
    END IF;

    PERFORM public.create_system_notification(
        p_employee_id,
        'Department KPI Board Assigned',
        'Your manager assigned the ' || v_dept_name || ' KPI board (' || v_count || ' metrics, total 100%). Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_count := v_count;
    department_name := v_dept_name;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_department_kpi_indicators(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_department_kpi_indicators(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT) TO authenticated;
