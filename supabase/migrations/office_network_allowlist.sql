-- office_network_allowlist.sql
-- R67 / Section M: Wi-Fi SSID/BSSID/public IP + detection mode per office zone

DO $$ BEGIN
  CREATE TYPE public.office_detection_mode AS ENUM ('gps_only', 'wifi_only', 'gps_or_wifi');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.office_locations
  ADD COLUMN IF NOT EXISTS wifi_ssids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS wifi_bssids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS public_ip_cidrs TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS detection_mode public.office_detection_mode NOT NULL DEFAULT 'gps_or_wifi';

CREATE OR REPLACE FUNCTION public.assert_public_ip_cidrs(p_cidrs TEXT[])
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  c TEXT;
  host TEXT;
BEGIN
  IF p_cidrs IS NULL THEN
    RETURN '{}';
  END IF;
  FOREACH c IN ARRAY p_cidrs LOOP
    c := btrim(c);
    IF c = '' THEN CONTINUE; END IF;
    host := split_part(c, '/', 1);
    IF host ~ '^10\.'
       OR host ~ '^192\.168\.'
       OR host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
       OR host = '127.0.0.1'
       OR host = '::1'
    THEN
      RAISE EXCEPTION 'Private IP ranges are not allowed in office public IP list: %', c;
    END IF;
  END LOOP;
  RETURN p_cidrs;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_locations_validate_network()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.public_ip_cidrs := public.assert_public_ip_cidrs(COALESCE(NEW.public_ip_cidrs, '{}'));
  -- Normalize BSSIDs to lowercase colon form when possible
  IF NEW.wifi_bssids IS NOT NULL THEN
    NEW.wifi_bssids := (
      SELECT COALESCE(array_agg(lower(btrim(x))), '{}')
      FROM unnest(NEW.wifi_bssids) AS x
      WHERE btrim(x) <> ''
    );
  END IF;
  IF NEW.wifi_ssids IS NOT NULL THEN
    NEW.wifi_ssids := (
      SELECT COALESCE(array_agg(btrim(x)), '{}')
      FROM unnest(NEW.wifi_ssids) AS x
      WHERE btrim(x) <> ''
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_office_locations_validate_network ON public.office_locations;
CREATE TRIGGER trg_office_locations_validate_network
  BEFORE INSERT OR UPDATE OF wifi_ssids, wifi_bssids, public_ip_cidrs
  ON public.office_locations
  FOR EACH ROW
  EXECUTE PROCEDURE public.office_locations_validate_network();

GRANT EXECUTE ON FUNCTION public.assert_public_ip_cidrs(TEXT[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
