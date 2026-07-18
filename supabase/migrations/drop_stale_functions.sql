-- Run first on every deploy: drop functions whose return types changed (CASCADE recreates deps in later migrations).

-- Shift attendance (TABLE return types)
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) CASCADE;
DROP FUNCTION IF EXISTS public.get_attendance_history(INTEGER, INTEGER, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_attendance_history(INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.get_team_shift_assignments() CASCADE;
DROP FUNCTION IF EXISTS public.get_my_shift() CASCADE;
DROP FUNCTION IF EXISTS public.assign_employee_shift(UUID, UUID, DATE) CASCADE;
DROP FUNCTION IF EXISTS public.delete_work_shift(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_manager_shifts() CASCADE;
DROP FUNCTION IF EXISTS public.get_active_shift_for_user(UUID, DATE) CASCADE;
DROP FUNCTION IF EXISTS public.get_active_shift_for_user(UUID) CASCADE;

-- Departments & KPI boards
DROP FUNCTION IF EXISTS public.get_departments() CASCADE;
DROP FUNCTION IF EXISTS public.get_department_weight_summary() CASCADE;
DROP FUNCTION IF EXISTS public.get_department_kpi_indicators(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.save_department_kpi_indicators(UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE) CASCADE;
DROP FUNCTION IF EXISTS public.seed_default_department_kpis(UUID) CASCADE;

-- Multi-tenant RPCs (TABLE return types)
DROP FUNCTION IF EXISTS public.get_direct_reports(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_all_users_admin() CASCADE;
DROP FUNCTION IF EXISTS public.get_my_company() CASCADE;
DROP FUNCTION IF EXISTS public.platform_get_companies() CASCADE;
DROP FUNCTION IF EXISTS public.platform_delete_company(UUID) CASCADE;

-- Scalar/bool functions — CREATE OR REPLACE without drop is fine; omit is_manager_of (RLS depends on it)
