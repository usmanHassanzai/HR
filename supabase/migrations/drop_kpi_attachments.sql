-- Remove KPI file attachments. Attendance and KPI rows are unchanged.

DROP POLICY IF EXISTS kpi_attachments_storage_select ON storage.objects;
DROP POLICY IF EXISTS kpi_attachments_storage_insert ON storage.objects;
DROP POLICY IF EXISTS kpi_attachments_storage_update ON storage.objects;
DROP POLICY IF EXISTS kpi_attachments_storage_delete ON storage.objects;

DROP TABLE IF EXISTS public.kpi_attachments CASCADE;

DROP FUNCTION IF EXISTS public.can_read_kpi_attachment(UUID);
DROP FUNCTION IF EXISTS public.can_write_kpi_attachment(UUID);
DROP FUNCTION IF EXISTS public.kpi_attachment_path_kpi_id(TEXT);

NOTIFY pgrst, 'reload schema';
