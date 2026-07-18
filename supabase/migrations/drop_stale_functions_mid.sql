-- Mid-deploy drops: multi_tenant recreates functions; later migrations change return types.

DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.get_my_company() CASCADE;
DROP FUNCTION IF EXISTS public.platform_get_companies() CASCADE;
DROP FUNCTION IF EXISTS public.platform_delete_company(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_direct_reports(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_department_kpi_indicators(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.save_department_kpi_indicators(UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE) CASCADE;
DROP FUNCTION IF EXISTS public.seed_default_department_kpis(UUID) CASCADE;
