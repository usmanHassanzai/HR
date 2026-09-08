-- PostgREST runs STABLE RPCs in a read-only transaction.
-- get_kpi_award_* call ensure_kpi_award_config() which INSERTs, so they must be VOLATILE.

ALTER FUNCTION public.ensure_kpi_award_config(UUID) VOLATILE;
ALTER FUNCTION public.get_kpi_award_config() VOLATILE;
ALTER FUNCTION public.get_kpi_award_pipeline() VOLATILE;
ALTER FUNCTION public.get_kpi_award_progress(UUID) VOLATILE;
