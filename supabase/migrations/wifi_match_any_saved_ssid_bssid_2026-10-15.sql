-- wifi_match_any_saved_ssid_bssid_2026-10-15.sql
-- Policy (auto + manual Clock in):
--   1) Current SSID or BSSID matches ANY saved office_wifi_networks row
--      (or legacy office_locations aggregates) for an ASSIGNED location
--      → check in via Wi-Fi (no GPS required). Public/arbitrary Wi-Fi never counts.
--   2) Else GPS inside assigned location radius → check in.
--   3) Else reject.
-- Optional public IP/CIDR remains an alternate identifier (browser / IP-only rows).
-- Normalizes BSSID dashes↔colons; SSID match is case-insensitive + quote-stripped.

CREATE OR REPLACE FUNCTION public.attendance_normalize_bssid(p_bssid TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    lower(replace(btrim(COALESCE(p_bssid, '')), '-', ':')),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.attendance_bssid_in_list(p_bssid TEXT, p_list TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    public.attendance_normalize_bssid(p_bssid) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_list, '{}'::text[])) AS b(bssid)
      WHERE public.attendance_normalize_bssid(b.bssid)
          = public.attendance_normalize_bssid(p_bssid)
    );
$$;

CREATE OR REPLACE FUNCTION public.attendance_match_office_wifi(
  p_office_id UUID,
  p_client_ip TEXT,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL
) RETURNS TABLE (
  matched BOOLEAN,
  network_id UUID,
  network_label TEXT,
  ssid_only_suspected BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n RECORD;
  v_ssid TEXT := public.attendance_normalize_ssid(p_ssid);
  v_bssid TEXT := public.attendance_normalize_bssid(p_bssid);
  v_net_count INT := 0;
  v_has_ssid BOOLEAN;
  v_has_bssid BOOLEAN;
  v_has_ip BOOLEAN;
  v_ssid_hit BOOLEAN;
  v_bssid_hit BOOLEAN;
  v_ip_hit BOOLEAN;
BEGIN
  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;

  SELECT count(*)::int INTO v_net_count
  FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id AND active;

  -- Legacy flat columns when no network rows exist.
  IF v_net_count = 0 THEN
    SELECT
      CASE
        WHEN public.attendance_ssid_in_list(v_ssid, o.wifi_ssids) THEN true
        WHEN public.attendance_bssid_in_list(v_bssid, o.wifi_bssids) THEN true
        WHEN cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
          AND public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
        THEN true
        ELSE false
      END,
      CASE
        WHEN public.attendance_ssid_in_list(v_ssid, o.wifi_ssids)
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
          AND cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
        THEN true
        ELSE false
      END
    INTO matched, ssid_only_suspected
    FROM public.office_locations o
    WHERE o.id = p_office_id;
    IF matched IS NULL THEN
      matched := false;
      ssid_only_suspected := false;
    END IF;
    -- Never match when location has no Wi-Fi / IP identifiers configured
    IF matched AND NOT EXISTS (
      SELECT 1 FROM public.office_locations o
      WHERE o.id = p_office_id
        AND (
          cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
          OR cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
          OR cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
        )
    ) THEN
      matched := false;
      ssid_only_suspected := false;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR n IN
    SELECT *
    FROM public.office_wifi_networks
    WHERE office_location_id = p_office_id AND active
    ORDER BY sort_order, created_at
  LOOP
    v_has_ssid := cardinality(COALESCE(n.ssids, '{}')) > 0;
    v_has_bssid := cardinality(COALESCE(n.wifi_bssids, '{}')) > 0;
    v_has_ip := cardinality(COALESCE(n.public_ip_cidrs, '{}')) > 0;

    IF NOT v_has_ssid AND NOT v_has_bssid AND NOT v_has_ip THEN
      CONTINUE;
    END IF;

    v_ssid_hit := v_has_ssid AND public.attendance_ssid_in_list(v_ssid, n.ssids);
    v_bssid_hit := v_has_bssid AND public.attendance_bssid_in_list(v_bssid, n.wifi_bssids);
    v_ip_hit := v_has_ip AND public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs);

    -- ANY saved identifier on this network row is enough (multi-SSID offices / mesh APs).
    IF v_ssid_hit OR v_bssid_hit OR v_ip_hit THEN
      matched := true;
      network_id := n.id;
      network_label := COALESCE(
        NULLIF(btrim(n.label), ''),
        CASE WHEN v_ssid_hit THEN v_ssid ELSE n.ssids[1] END
      );
      ssid_only_suspected := v_has_ssid AND NOT v_has_bssid AND NOT v_has_ip;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;

  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;
  RETURN NEXT;
END;
$$;

-- Keep office_locations.wifi_* as the union of all active network rows (schedule / clients).
DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'sync_office_location_wifi_aggregates'
  ) THEN
    FOR r IN SELECT id FROM public.office_locations LOOP
      PERFORM public.sync_office_location_wifi_aggregates(r.id);
    END LOOP;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_normalize_bssid(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_bssid_in_list(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.attendance_match_office_wifi(uuid, text, text, text) IS
  'Matches ANY saved office Wi-Fi for a location: case-insensitive SSID OR normalized BSSID OR public IP. Empty configs / unsaved public Wi-Fi never match.';

NOTIFY pgrst, 'reload schema';
