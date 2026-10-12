-- A laptop on office Wi-Fi only shows the office public IP. It cannot read the
-- router BSSID, so Test now was rejected even when that IP was already saved.
-- Public IP inside an office network is enough. A copied Wi-Fi name with the
-- wrong IP is still rejected.

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
  v_ssid TEXT := NULLIF(btrim(COALESCE(p_ssid, '')), '');
  v_bssid TEXT := NULLIF(lower(btrim(COALESCE(p_bssid, ''))), '');
  v_ssid_only BOOLEAN := false;
  v_net_count INT := 0;
  v_ip_network_id UUID := NULL;
  v_ip_network_label TEXT := NULL;
BEGIN
  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;

  SELECT count(*)::int INTO v_net_count
  FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id AND active;

  IF v_net_count = 0 THEN
    SELECT
      public.attendance_ip_in_cidrs(p_client_ip, COALESCE(o.public_ip_cidrs, '{}')),
      CASE
        WHEN v_ssid IS NOT NULL
             AND cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
             AND v_ssid = ANY (o.wifi_ssids)
             AND NOT public.attendance_ip_in_cidrs(p_client_ip, COALESCE(o.public_ip_cidrs, '{}'))
        THEN true ELSE false
      END
    INTO matched, ssid_only_suspected
    FROM public.office_locations o
    WHERE o.id = p_office_id;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR n IN
    SELECT *
    FROM public.office_wifi_networks
    WHERE office_location_id = p_office_id AND active
    ORDER BY sort_order, created_at
  LOOP
    IF public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs) THEN
      IF v_ip_network_id IS NULL THEN
        v_ip_network_id := n.id;
        v_ip_network_label := n.label;
      END IF;

      IF cardinality(n.wifi_bssids) > 0 AND v_bssid IS NOT NULL THEN
        IF v_bssid = ANY (n.wifi_bssids) THEN
          matched := true;
          network_id := n.id;
          network_label := n.label;
          RETURN NEXT;
          RETURN;
        END IF;
      ELSIF cardinality(n.ssids) > 0 AND v_ssid IS NOT NULL AND cardinality(n.wifi_bssids) = 0 THEN
        IF v_ssid = ANY (n.ssids) THEN
          matched := true;
          network_id := n.id;
          network_label := n.label;
          RETURN NEXT;
          RETURN;
        END IF;
      ELSE
        -- Laptop / desktop: office public IP, no router MAC available.
        matched := true;
        network_id := n.id;
        network_label := n.label;
        RETURN NEXT;
        RETURN;
      END IF;
    ELSIF v_ssid IS NOT NULL AND cardinality(n.ssids) > 0 AND v_ssid = ANY (n.ssids) THEN
      v_ssid_only := true;
    END IF;
  END LOOP;

  -- On the office public IP, but the phone reported a different radio MAC
  -- (another band, or a randomized address). The internet address is the office.
  IF v_ip_network_id IS NOT NULL THEN
    matched := true;
    network_id := v_ip_network_id;
    network_label := v_ip_network_label;
    ssid_only_suspected := false;
    RETURN NEXT;
    RETURN;
  END IF;

  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := v_ssid_only;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
