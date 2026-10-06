-- attendance_devices.sql
-- R29 / E: enrolled devices with token hash only

CREATE TABLE IF NOT EXISTS public.attendance_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'linux', 'web')),
  device_timezone TEXT,
  app_version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_clock_skew_ms BIGINT,
  revoked_at TIMESTAMPTZ,
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_devices_company
  ON public.attendance_devices(company_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_devices_user
  ON public.attendance_devices(user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_devices_select ON public.attendance_devices;
CREATE POLICY attendance_devices_select ON public.attendance_devices
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND me.company_id = attendance_devices.company_id
        AND me.role IN ('admin', 'hr')
    )
  );

-- No direct insert/update/delete for clients; service role / security definer RPCs only
DROP POLICY IF EXISTS attendance_devices_no_client_write ON public.attendance_devices;
CREATE POLICY attendance_devices_no_client_write ON public.attendance_devices
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

NOTIFY pgrst, 'reload schema';
