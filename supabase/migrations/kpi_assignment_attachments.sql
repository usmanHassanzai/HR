-- Files attached when a manager/admin assigns a KPI (PDF, Office, CSV, etc.)

CREATE TABLE IF NOT EXISTS public.kpi_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kpi_id UUID NOT NULL REFERENCES public.kpis(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT,
    file_size INTEGER,
    uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_kpi_attachments_kpi ON public.kpi_attachments (kpi_id);

ALTER TABLE public.kpi_attachments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_read_kpi_attachment(p_kpi_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kpis k
    WHERE k.id = p_kpi_id
      AND (
        k.user_id = auth.uid()
        OR public.is_manager_of(auth.uid(), k.user_id)
        OR (public.is_admin(auth.uid()) AND public.can_access_user_data(k.user_id))
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_write_kpi_attachment(p_kpi_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kpis k
    WHERE k.id = p_kpi_id
      AND (
        public.is_manager_of(auth.uid(), k.user_id)
        OR (public.is_admin(auth.uid()) AND public.can_access_user_data(k.user_id))
      )
  );
$$;

DROP POLICY IF EXISTS kpi_attachments_select ON public.kpi_attachments;
CREATE POLICY kpi_attachments_select ON public.kpi_attachments
FOR SELECT TO authenticated
USING (public.can_read_kpi_attachment(kpi_id));

DROP POLICY IF EXISTS kpi_attachments_insert ON public.kpi_attachments;
CREATE POLICY kpi_attachments_insert ON public.kpi_attachments
FOR INSERT TO authenticated
WITH CHECK (
    uploaded_by = auth.uid()
    AND public.can_write_kpi_attachment(kpi_id)
);

DROP POLICY IF EXISTS kpi_attachments_delete ON public.kpi_attachments;
CREATE POLICY kpi_attachments_delete ON public.kpi_attachments
FOR DELETE TO authenticated
USING (public.can_write_kpi_attachment(kpi_id));

GRANT SELECT, INSERT, DELETE ON public.kpi_attachments TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_kpi_attachment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_kpi_attachment(UUID) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('kpi-attachments', 'kpi-attachments', false, 20971520)
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

CREATE OR REPLACE FUNCTION public.kpi_attachment_path_kpi_id(p_path TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_part TEXT := split_part(COALESCE(p_path, ''), '/', 1);
BEGIN
    IF v_part ~ '^[0-9a-fA-F-]{36}$' THEN
        RETURN v_part::UUID;
    END IF;
    RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_attachment_path_kpi_id(TEXT) TO authenticated;

DROP POLICY IF EXISTS kpi_attachments_storage_select ON storage.objects;
CREATE POLICY kpi_attachments_storage_select ON storage.objects
FOR SELECT TO authenticated
USING (
    bucket_id = 'kpi-attachments'
    AND public.can_read_kpi_attachment(public.kpi_attachment_path_kpi_id(name))
);

DROP POLICY IF EXISTS kpi_attachments_storage_insert ON storage.objects;
CREATE POLICY kpi_attachments_storage_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'kpi-attachments'
    AND public.can_write_kpi_attachment(public.kpi_attachment_path_kpi_id(name))
);

DROP POLICY IF EXISTS kpi_attachments_storage_update ON storage.objects;
CREATE POLICY kpi_attachments_storage_update ON storage.objects
FOR UPDATE TO authenticated
USING (
    bucket_id = 'kpi-attachments'
    AND public.can_write_kpi_attachment(public.kpi_attachment_path_kpi_id(name))
);

DROP POLICY IF EXISTS kpi_attachments_storage_delete ON storage.objects;
CREATE POLICY kpi_attachments_storage_delete ON storage.objects
FOR DELETE TO authenticated
USING (
    bucket_id = 'kpi-attachments'
    AND public.can_write_kpi_attachment(public.kpi_attachment_path_kpi_id(name))
);

NOTIFY pgrst, 'reload schema';
