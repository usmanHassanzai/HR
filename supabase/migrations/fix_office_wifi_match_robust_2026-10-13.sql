-- fix_office_wifi_match_robust_2026-10-13.sql
-- Restore missing attendance_ip_in_cidrs and make office Wi-Fi matching robust:
--   - case-insensitive SSID, trim + strip surrounding quotes
--   - match when ANY configured identifier hits (SSID OR BSSID OR public IP)
--   - never match empty network configs / arbitrary public Wi-Fi
-- Applied live; do not require redeploy of web for matcher itself.

CREATE OR REPLACE FUNCTION public.attendance_ip_in_cidrs(p_ip TEXT, p_cidrs TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  c TEXT;
  host TEXT;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' OR p_cidrs IS NULL THEN
    RETURN false;
  END IF;
  FOREACH c IN ARRAY p_cidrs LOOP
    c := btrim(c);
    IF c = '' THEN CONTINUE; END IF;
    host := split_part(c, '/', 1);
    IF p_ip = host OR p_ip = c THEN
      RETURN true;
    END IF;
    BEGIN
      IF p_ip::inet <<= c::inet THEN
        RETURN true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_normalize_ssid(p_ssid TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(btrim(btrim(COALESCE(p_ssid, '')), '"'), '');
$$;

CREATE OR REPLACE FUNCTION public.attendance_ssid_in_list(p_ssid TEXT, p_list TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    public.attendance_normalize_ssid(p_ssid) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_list, '{}'::text[])) AS s(ssid)
      WHERE lower(public.attendance_normalize_ssid(s.ssid))
          = lower(public.attendance_normalize_ssid(p_ssid))
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
  v_bssid TEXT := NULLIF(lower(btrim(COALESCE(p_bssid, ''))), '');
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
        WHEN cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
          AND v_bssid IS NOT NULL
          AND v_bssid = ANY (o.wifi_bssids)
        THEN true
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
    v_bssid_hit := v_has_bssid AND v_bssid IS NOT NULL AND v_bssid = ANY (n.wifi_bssids);
    v_ip_hit := v_has_ip AND public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs);

    -- Any configured identifier is enough (mesh APs / rotating egress / browser IP-only).
    IF v_ssid_hit OR v_bssid_hit OR v_ip_hit THEN
      matched := true;
      network_id := n.id;
      network_label := COALESCE(NULLIF(btrim(n.label), ''), CASE WHEN v_ssid_hit THEN v_ssid ELSE n.ssids[1] END);
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

GRANT EXECUTE ON FUNCTION public.attendance_ip_in_cidrs(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_normalize_ssid(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_ssid_in_list(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.attendance_match_office_wifi(uuid, text, text, text) IS
  'Matches configured office Wi-Fi for a location: case-insensitive SSID OR BSSID OR public IP. Empty configs never match.';

NOTIFY pgrst, 'reload schema';
