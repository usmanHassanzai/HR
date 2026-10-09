-- Status card: realtime for enrolled-device attendance_events_log (and visit segments).
-- No rule / RPC behavior changes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'attendance_events_log'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_events_log;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'attendance_visit_segments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_visit_segments;
  END IF;
END $$;
