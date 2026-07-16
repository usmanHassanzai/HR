-- Ensure all 4 functional departments are active, open, and have KPI indicators

UPDATE public.departments SET active = true, updated_at = timezone('utc'::text, now())
WHERE slug IN ('finance', 'sales-marketing', 'human-resources', 'operations-supply-chain');

INSERT INTO public.departments (name, slug, org_weight_pct, is_demo, active) VALUES
    ('Finance', 'finance', 25.00, false, true),
    ('Sales & Marketing', 'sales-marketing', 25.00, false, true),
    ('Human Resources', 'human-resources', 25.00, false, true),
    ('Operations & Supply Chain', 'operations-supply-chain', 25.00, false, true)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    org_weight_pct = EXCLUDED.org_weight_pct,
    active = true,
    updated_at = timezone('utc'::text, now());

-- Re-seed indicators (idempotent)
INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order, active)
SELECT d.id, v.name, v.description, v.weight_pct, v.sort_order, true
FROM public.departments d
CROSS JOIN (VALUES
    ('finance', 'Budget Variance', 'Measures differences between projected and actual costs.', 30.00, 1),
    ('finance', 'Accounts Receivable Turnover', 'Tracks speed of client payments.', 30.00, 2),
    ('finance', 'Gross Profit Margin', 'Evaluates conversion of revenue to profit.', 20.00, 3),
    ('finance', 'Operating Cash Flow', 'Assesses cash generated versus required to sustain operations.', 20.00, 4),
    ('sales-marketing', 'Lead Conversion Rate', 'Percentage of leads that turn into customers.', 30.00, 1),
    ('sales-marketing', 'Customer Acquisition Cost (CAC)', 'Total marketing/sales spend divided by new customers.', 30.00, 2),
    ('sales-marketing', 'Monthly Sales Target / Volume', 'Actual revenue versus monthly quota.', 30.00, 3),
    ('sales-marketing', 'Customer Retention', 'Rate of retained customers or renewals.', 10.00, 4),
    ('human-resources', 'Monthly Employee Turnover Rate', 'Percentage of staff leaving the organization.', 30.00, 1),
    ('human-resources', 'Time to Hire', 'Average days to fill an open position.', 30.00, 2),
    ('human-resources', 'Training & Development Hours', 'Average hours completed per employee.', 20.00, 3),
    ('human-resources', 'Employee Satisfaction (NPS)', 'Score reflecting workplace engagement.', 20.00, 4),
    ('operations-supply-chain', 'On-Time Delivery (OTD)', 'Orders delivered within the promised time frame.', 40.00, 1),
    ('operations-supply-chain', 'Defect or Error Rate', 'Percentage of products/services failing quality checks.', 30.00, 2),
    ('operations-supply-chain', 'Process Efficiency / Turnaround Time', 'Average time to complete a core service request.', 30.00, 3)
) AS v(slug, name, description, weight_pct, sort_order)
WHERE d.slug = v.slug
ON CONFLICT (department_id, name) DO UPDATE SET
    description = EXCLUDED.description,
    weight_pct = EXCLUDED.weight_pct,
    sort_order = EXCLUDED.sort_order,
    active = true,
    updated_at = timezone('utc'::text, now());

-- Departments list with indicator counts (open to all authenticated users)
DROP FUNCTION IF EXISTS public.get_departments();

CREATE OR REPLACE FUNCTION public.get_departments()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    org_weight_pct NUMERIC,
    active BOOLEAN,
    kpi_count BIGINT,
    active_kpi_count BIGINT,
    indicator_count BIGINT
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
        COUNT(DISTINCT k.id) AS kpi_count,
        COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending') AS active_kpi_count,
        COUNT(DISTINCT i.id) FILTER (WHERE i.active = true) AS indicator_count
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
    LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
    WHERE d.active = true
    GROUP BY d.id
    ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_departments() TO authenticated;
