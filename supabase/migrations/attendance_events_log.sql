-- attendance_events_log.sql + attendance_corrections_audit.sql (R58)

CREATE TABLE IF NOT EXISTS public.attendance_events_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES public.attendance_devices(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  reason_code TEXT,
  client_ip TEXT,
  matched_method TEXT,
  skew_ms BIGINT,
  clock_flagged BOOLEAN NOT NULL DEFAULT false,
  zone_id UUID,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  ssid TEXT,
  bssid TEXT,
  occurred_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_attendance_events_log_company_created
  ON public.attendance_events_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_events_log_user_created
  ON public.attendance_events_log(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.attendance_corrections_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  attendance_record_id UUID REFERENCES public.attendance_records(id) ON DELETE SET NULL,
  target_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason TEXT,
  before JSONB NOT NULL DEFAULT '{}'::JSONB,
  after JSONB NOT NULL DEFAULT '{}'::JSONB,
  kind TEXT NOT NULL DEFAULT 'admin_correction',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_attendance_corrections_company
  ON public.attendance_corrections_audit(company_id, created_at DESC);

ALTER TABLE public.attendance_events_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_corrections_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_events_log_select ON public.attendance_events_log;
CREATE POLICY attendance_events_log_select ON public.attendance_events_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND me.company_id = attendance_events_log.company_id
        AND me.role IN ('admin', 'hr')
    )
  );

DROP POLICY IF EXISTS attendance_events_log_no_client_write ON public.attendance_events_log;
CREATE POLICY attendance_events_log_no_client_write ON public.attendance_events_log
  FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS attendance_corrections_select ON public.attendance_corrections_audit;
CREATE POLICY attendance_corrections_select ON public.attendance_corrections_audit
  FOR SELECT TO authenticated
  USING (
    target_user_id = auth.uid()
    OR actor_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND me.company_id = attendance_corrections_audit.company_id
        AND me.role IN ('admin', 'hr')
    )
  );

DROP POLICY IF EXISTS attendance_corrections_no_client_write ON public.attendance_corrections_audit;
CREATE POLICY attendance_corrections_no_client_write ON public.attendance_corrections_audit
  FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

NOTIFY pgrst, 'reload schema';
