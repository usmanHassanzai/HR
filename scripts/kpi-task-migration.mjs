/** Apply KPI task migration to live Supabase DB */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();

async function sql(q) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 600));
  return body;
}

const migration = `
DO $$ BEGIN CREATE TYPE kpi_completion_status AS ENUM ('pending', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.kpis ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE public.kpis ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE public.kpis ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE public.kpis ADD COLUMN IF NOT EXISTS redo_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.kpis ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE public.kpis ADD COLUMN completion_status kpi_completion_status NOT NULL DEFAULT 'pending';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DROP POLICY IF EXISTS "Managers can manage team KPIs" ON public.kpis;
CREATE POLICY "Managers can manage team KPIs" ON public.kpis FOR ALL
  USING (public.is_manager_of(auth.uid(), user_id))
  WITH CHECK (public.is_manager_of(auth.uid(), user_id));
`;

const functions = `
CREATE OR REPLACE FUNCTION public.assign_kpi_manager(
    p_employee_id UUID, p_department TEXT, p_description TEXT,
    p_start_date DATE, p_end_date DATE
) RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID) AS $$
DECLARE v_kpi_id UUID; v_email TEXT; v_name TEXT;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;
    INSERT INTO public.kpis (user_id, name, description, department, category, start_date, end_date,
        target_value, current_value, weight, direction, status, completion_status, redo_count)
    VALUES (p_employee_id, p_department, p_description, p_department, p_department,
        p_start_date, p_end_date, 100, 0, 1, 'higher_better', 'at_risk', 'pending', 0)
    RETURNING id INTO v_kpi_id;
    PERFORM public.create_system_notification(p_employee_id, 'New KPI Assigned',
        'KPI in ' || p_department || '. Due by ' || p_end_date::TEXT || '.', 'info');
    employee_email := v_email; employee_name := COALESCE(v_name, 'Employee'); kpi_id := v_kpi_id;
    RETURN NEXT;
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.complete_kpi_employee(p_kpi_id UUID)
RETURNS TABLE(manager_email TEXT, manager_name TEXT, department TEXT) AS $$
DECLARE v_kpi public.kpis%ROWTYPE; v_mgr_email TEXT; v_mgr_name TEXT;
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF v_kpi.completion_status = 'completed' THEN RAISE EXCEPTION 'Already completed'; END IF;
    UPDATE public.kpis SET completion_status = 'completed', status = 'on_track', current_value = 100, updated_at = now() WHERE id = p_kpi_id;
    SELECT u.email, u.full_name INTO v_mgr_email, v_mgr_name FROM public.users emp
        JOIN public.users u ON u.id = emp.manager_id WHERE emp.id = auth.uid();
    IF (SELECT manager_id FROM public.users WHERE id = auth.uid()) IS NOT NULL THEN
        PERFORM public.create_system_notification((SELECT manager_id FROM public.users WHERE id = auth.uid()),
            'KPI Completed', (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' completed: ' || COALESCE(v_kpi.department, v_kpi.name), 'info');
    END IF;
    manager_email := v_mgr_email; manager_name := COALESCE(v_mgr_name, 'Manager');
    department := COALESCE(v_kpi.department, v_kpi.name); RETURN NEXT;
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_overdue_kpis()
RETURNS TABLE(emp_email TEXT, emp_name TEXT, department TEXT, end_date DATE, redo_count INTEGER) AS $$
DECLARE rec RECORD; v_month DATE := date_trunc('month', now())::DATE;
BEGIN
    FOR rec IN SELECT k.*, u.email AS e_email, u.full_name AS e_name FROM public.kpis k
        JOIN public.users u ON u.id = k.user_id
        WHERE k.completion_status = 'pending' AND k.end_date IS NOT NULL AND k.end_date < CURRENT_DATE
        AND (k.overdue_notified_at IS NULL OR k.overdue_notified_at::DATE < CURRENT_DATE)
    LOOP
        UPDATE public.kpis SET redo_count = redo_count + 1, status = 'off_track', overdue_notified_at = now(), updated_at = now() WHERE id = rec.id;
        PERFORM public.create_system_notification(rec.user_id, 'KPI Overdue',
            COALESCE(rec.department, rec.name) || ' overdue. Miss ' || (rec.redo_count + 1) || '/3.', 'alert');
        IF rec.redo_count + 1 >= 3 THEN
            INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned) VALUES (rec.user_id, v_month, 0, -300)
            ON CONFLICT (employee_id, month) DO UPDATE SET points_earned = public.points_ledger.points_earned - 300;
            PERFORM public.create_system_notification(rec.user_id, 'Points Deducted', '3 missed deadlines — 300 points deducted.', 'escalation');
        END IF;
        emp_email := rec.e_email; emp_name := COALESCE(rec.e_name, 'Employee');
        department := COALESCE(rec.department, rec.name); end_date := rec.end_date; redo_count := rec.redo_count + 1;
        RETURN NEXT;
    END LOOP;
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
`;

async function main() {
  console.log('Applying KPI task migration...');
  await sql(migration);
  await sql(functions);

  const cols = await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='kpis' AND column_name IN ('department','start_date','end_date','completion_status','redo_count') ORDER BY 1`);
  const fns = await sql(`SELECT proname FROM pg_proc JOIN pg_namespace n ON n.oid=pg_proc.pronamespace WHERE n.nspname='public' AND proname IN ('assign_kpi_manager','complete_kpi_employee','check_overdue_kpis')`);
  console.log('Columns OK:', (cols || []).map?.((r) => r.column_name).join(', ') || cols);
  console.log('RPCs OK:', (fns || []).map?.((r) => r.proname).join(', ') || fns);
  console.log('Done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
