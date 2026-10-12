-- Do not clock out when the app is off. Checkout only from a GPS ping:
-- inside radius → stay checked in; outside radius → check out; shift ended → check out.

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('scorr-close-ended-shifts');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$outer$;

-- Kept for compatibility; never close attendance without a location ping.
CREATE OR REPLACE FUNCTION public.close_all_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN 0;
END;
$$;

NOTIFY pgrst, 'reload schema';
