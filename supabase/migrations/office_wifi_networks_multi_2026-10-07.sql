-- Multi Wi-Fi networks per office zone (admin UI + R68 matching per network).
-- Staging first, then production.

CREATE TABLE IF NOT EXISTS public.office_wifi_networks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_location_id UUID NOT NULL REFERENCES public.office_locations(id) ON DELETE CASCADE,
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  ssids TEXT[] NOT NULL DEFAULT '{}',
  wifi_bssids TEXT[] NOT NULL DEFAULT '{}',
  public_ip_cidrs TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT office_wifi_networks_label_nonempty CHECK (btrim(label) <> '')
);

CREATE INDEX IF NOT EXISTS idx_office_wifi_networks_office
  ON public.office_wifi_networks (office_location_id, sort_order);

ALTER TABLE public.attendance_events_log
  ADD COLUMN IF NOT EXISTS wifi_network_id UUID,
  ADD COLUMN IF NOT EXISTS wifi_network_label TEXT;

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS wifi_network_id UUID,
  ADD COLUMN IF NOT EXISTS wifi_network_label TEXT;

ALTER TABLE public.attendance_visit_segments
  ADD COLUMN IF NOT EXISTS wifi_network_id UUID,
  ADD COLUMN IF NOT EXISTS wifi_network_label TEXT;

-- Migrate legacy flat columns → first "Main Wi-Fi" row (idempotent).
INSERT INTO public.office_wifi_networks (
  office_location_id, company_id, label, ssids, wifi_bssids, public_ip_cidrs, active, sort_order
)
SELECT
  o.id,
  o.company_id,
  'Main Wi-Fi',
  COALESCE(o.wifi_ssids, '{}'),
  COALESCE(o.wifi_bssids, '{}'),
  COALESCE(o.public_ip_cidrs, '{}'),
  true,
  0
FROM public.office_locations o
WHERE (
    cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
    OR cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
    OR cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.office_wifi_networks n WHERE n.office_location_id = o.id
  );

CREATE OR REPLACE FUNCTION public.office_wifi_networks_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.label := btrim(NEW.label);
  NEW.ssids := (
    SELECT COALESCE(array_agg(DISTINCT btrim(x) ORDER BY btrim(x)), '{}')
    FROM unnest(COALESCE(NEW.ssids, '{}')) AS x
    WHERE btrim(x) <> ''
  );
  NEW.wifi_bssids := (
    SELECT COALESCE(array_agg(DISTINCT lower(btrim(x)) ORDER BY lower(btrim(x))), '{}')
    FROM unnest(COALESCE(NEW.wifi_bssids, '{}')) AS x
    WHERE btrim(x) <> ''
  );
  NEW.public_ip_cidrs := public.assert_public_ip_cidrs(COALESCE(NEW.public_ip_cidrs, '{}'));
  IF cardinality(NEW.public_ip_cidrs) = 0 THEN
    RAISE EXCEPTION 'Each Wi-Fi network needs at least one public IP / CIDR (SSID alone is not enough)';
  END IF;
  NEW.updated_at := timezone('utc', now());
  IF NEW.company_id IS NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.office_locations WHERE id = NEW.office_location_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_office_wifi_networks_normalize ON public.office_wifi_networks;
CREATE TRIGGER trg_office_wifi_networks_normalize
  BEFORE INSERT OR UPDATE ON public.office_wifi_networks
  FOR EACH ROW EXECUTE PROCEDURE public.office_wifi_networks_normalize();

-- Keep legacy office_locations wifi_* arrays as the union of active networks (device clients).
CREATE OR REPLACE FUNCTION public.sync_office_location_wifi_aggregates(p_office_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.office_locations o SET
    wifi_ssids = COALESCE((
      SELECT array_agg(DISTINCT s ORDER BY s)
      FROM public.office_wifi_networks n, unnest(n.ssids) s
      WHERE n.office_location_id = p_office_id AND n.active AND btrim(s) <> ''
    ), '{}'),
    wifi_bssids = COALESCE((
      SELECT array_agg(DISTINCT b ORDER BY b)
      FROM public.office_wifi_networks n, unnest(n.wifi_bssids) b
      WHERE n.office_location_id = p_office_id AND n.active AND btrim(b) <> ''
    ), '{}'),
    public_ip_cidrs = COALESCE((
      SELECT array_agg(DISTINCT c ORDER BY c)
      FROM public.office_wifi_networks n, unnest(n.public_ip_cidrs) c
      WHERE n.office_location_id = p_office_id AND n.active AND btrim(c) <> ''
    ), '{}'),
    updated_at = timezone('utc', now())
  WHERE o.id = p_office_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_office_wifi_aggregates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_office UUID;
BEGIN
  v_office := COALESCE(NEW.office_location_id, OLD.office_location_id);
  PERFORM public.sync_office_location_wifi_aggregates(v_office);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_office_wifi_networks_sync_agg ON public.office_wifi_networks;
CREATE TRIGGER trg_office_wifi_networks_sync_agg
  AFTER INSERT OR UPDATE OR DELETE ON public.office_wifi_networks
  FOR EACH ROW EXECUTE PROCEDURE public.trg_sync_office_wifi_aggregates();

-- Re-sync aggregates after migration
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT office_location_id FROM public.office_wifi_networks LOOP
    PERFORM public.sync_office_location_wifi_aggregates(r.office_location_id);
  END LOOP;
END $$;

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
BEGIN
  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;

  SELECT count(*)::int INTO v_net_count
  FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id AND active;

  -- Legacy fallback: no network rows yet → use office_locations flat columns (pre-migration edge).
  IF v_net_count = 0 THEN
    SELECT
      CASE
        WHEN cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
             AND public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs) THEN
          CASE
            WHEN cardinality(COALESCE(o.wifi_bssids, '{}')) > 0 THEN
              (v_bssid IS NOT NULL AND v_bssid = ANY (o.wifi_bssids))
            WHEN cardinality(COALESCE(o.wifi_ssids, '{}')) > 0 THEN
              (v_ssid IS NOT NULL AND v_ssid = ANY (o.wifi_ssids))
            ELSE true
          END
        ELSE false
      END,
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
      IF cardinality(n.wifi_bssids) > 0 THEN
        IF v_bssid IS NOT NULL AND v_bssid = ANY (n.wifi_bssids) THEN
          matched := true;
          network_id := n.id;
          network_label := n.label;
          RETURN NEXT;
          RETURN;
        END IF;
      ELSIF cardinality(n.ssids) > 0 THEN
        IF v_ssid IS NOT NULL AND v_ssid = ANY (n.ssids) THEN
          matched := true;
          network_id := n.id;
          network_label := n.label;
          RETURN NEXT;
          RETURN;
        END IF;
      ELSE
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

  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := v_ssid_only;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_wifi_duplicate_warnings(
  p_office_id UUID,
  p_networks JSONB
) RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  warnings TEXT[] := '{}';
  seen_ssid TEXT[] := '{}';
  seen_bssid TEXT[] := '{}';
  seen_ip TEXT[] := '{}';
  elem JSONB;
  s TEXT;
  b TEXT;
  c TEXT;
  ssids TEXT[];
  bssids TEXT[];
  ips TEXT[];
BEGIN
  IF p_networks IS NULL THEN RETURN warnings; END IF;
  FOR elem IN SELECT * FROM jsonb_array_elements(p_networks)
  LOOP
    IF NOT COALESCE((elem->>'active')::boolean, true) THEN CONTINUE; END IF;
    ssids := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'ssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    IF elem ? 'ssid' AND NULLIF(btrim(elem->>'ssid'), '') IS NOT NULL THEN
      ssids := array_append(ssids, btrim(elem->>'ssid'));
    END IF;
    bssids := COALESCE(
      ARRAY(SELECT lower(btrim(x::text)) FROM jsonb_array_elements_text(COALESCE(elem->'wifi_bssids', elem->'bssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    ips := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'public_ip_cidrs', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    FOREACH s IN ARRAY ssids LOOP
      IF s = ANY (seen_ssid) THEN
        warnings := array_append(warnings, format('Duplicate SSID "%s" across networks in this office', s));
      ELSE
        seen_ssid := array_append(seen_ssid, s);
      END IF;
    END LOOP;
    FOREACH b IN ARRAY bssids LOOP
      IF b = ANY (seen_bssid) THEN
        warnings := array_append(warnings, format('Duplicate BSSID "%s" across networks in this office', b));
      ELSE
        seen_bssid := array_append(seen_bssid, b);
      END IF;
    END LOOP;
    FOREACH c IN ARRAY ips LOOP
      IF c = ANY (seen_ip) THEN
        warnings := array_append(warnings, format('Duplicate public IP/CIDR "%s" across networks in this office', c));
      ELSE
        seen_ip := array_append(seen_ip, c);
      END IF;
    END LOOP;
  END LOOP;
  RETURN warnings;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_office_wifi_networks(p_office_id UUID)
RETURNS SETOF public.office_wifi_networks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT n.* FROM public.office_wifi_networks n
    JOIN public.office_locations o ON o.id = n.office_location_id
    WHERE n.office_location_id = p_office_id AND o.is_demo = true
    ORDER BY n.sort_order, n.created_at;
    RETURN;
  END IF;
  v_company := public.current_company_id();
  RETURN QUERY
  SELECT n.* FROM public.office_wifi_networks n
  JOIN public.office_locations o ON o.id = n.office_location_id
  WHERE n.office_location_id = p_office_id
    AND o.company_id = v_company
  ORDER BY n.sort_order, n.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_office_wifi_networks(
  p_office_id UUID,
  p_networks JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_demo BOOLEAN;
  elem JSONB;
  v_id UUID;
  v_label TEXT;
  v_ssids TEXT[];
  v_bssids TEXT[];
  v_ips TEXT[];
  v_active BOOLEAN;
  v_sort INT := 0;
  v_keep UUID[] := '{}';
  v_warnings TEXT[];
  v_count INT := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Only admins can manage office Wi-Fi networks'; END IF;

  v_demo := public.is_demo_user(v_uid);
  IF v_demo THEN
    IF NOT EXISTS (SELECT 1 FROM public.office_locations WHERE id = p_office_id AND is_demo) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  ELSE
    v_company := public.current_company_id();
    IF NOT EXISTS (SELECT 1 FROM public.office_locations WHERE id = p_office_id AND company_id = v_company) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  END IF;

  IF p_networks IS NULL OR jsonb_typeof(p_networks) <> 'array' THEN
    RAISE EXCEPTION 'p_networks must be a JSON array';
  END IF;
  IF jsonb_array_length(p_networks) > 50 THEN
    RAISE EXCEPTION 'At most 50 Wi-Fi networks per office';
  END IF;

  v_warnings := public.office_wifi_duplicate_warnings(p_office_id, p_networks);

  FOR elem IN SELECT * FROM jsonb_array_elements(p_networks)
  LOOP
    v_label := NULLIF(btrim(COALESCE(elem->>'label', '')), '');
    v_ssids := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'ssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    IF elem ? 'ssid' AND NULLIF(btrim(elem->>'ssid'), '') IS NOT NULL THEN
      v_ssids := ARRAY[btrim(elem->>'ssid')] || v_ssids;
    END IF;
    -- dedupe ssids
    SELECT COALESCE(array_agg(DISTINCT s), '{}') INTO v_ssids FROM unnest(v_ssids) s WHERE btrim(s) <> '';

    v_bssids := COALESCE(
      ARRAY(SELECT lower(btrim(x::text)) FROM jsonb_array_elements_text(COALESCE(elem->'wifi_bssids', elem->'bssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    v_ips := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'public_ip_cidrs', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    v_active := COALESCE((elem->>'active')::boolean, true);

    -- Skip completely empty draft rows
    IF v_label IS NULL AND cardinality(v_ssids) = 0 AND cardinality(v_bssids) = 0 AND cardinality(v_ips) = 0 THEN
      CONTINUE;
    END IF;

    IF v_label IS NULL THEN
      RAISE EXCEPTION 'Each Wi-Fi network needs a label';
    END IF;
    IF cardinality(v_ips) = 0 THEN
      RAISE EXCEPTION 'Network "%" needs at least one public IP / CIDR', v_label;
    END IF;

    v_id := NULLIF(elem->>'id', '')::uuid;

    IF v_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.office_wifi_networks
      WHERE id = v_id AND office_location_id = p_office_id
    ) THEN
      UPDATE public.office_wifi_networks SET
        label = v_label,
        ssids = v_ssids,
        wifi_bssids = v_bssids,
        public_ip_cidrs = v_ips,
        active = v_active,
        sort_order = v_sort
      WHERE id = v_id;
    ELSE
      INSERT INTO public.office_wifi_networks (
        office_location_id, company_id, label, ssids, wifi_bssids, public_ip_cidrs, active, sort_order
      ) VALUES (
        p_office_id, v_company, v_label, v_ssids, v_bssids, v_ips, v_active, v_sort
      ) RETURNING id INTO v_id;
    END IF;

    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
    v_count := v_count + 1;
  END LOOP;

  DELETE FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id
    AND (cardinality(v_keep) = 0 OR NOT (id = ANY (v_keep)));

  PERFORM public.sync_office_location_wifi_aggregates(p_office_id);

  RETURN jsonb_build_object(
    'ok', true,
    'count', v_count,
    'warnings', to_jsonb(COALESCE(v_warnings, '{}'))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_office_wifi_network(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_office UUID;
  v_company UUID;
BEGIN
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Only admins can delete office Wi-Fi networks'; END IF;
  SELECT office_location_id, company_id INTO v_office, v_company
  FROM public.office_wifi_networks WHERE id = p_id;
  IF v_office IS NULL THEN RAISE EXCEPTION 'Network not found'; END IF;
  IF NOT public.is_demo_user(v_uid) THEN
    IF v_company IS DISTINCT FROM public.current_company_id() THEN
      RAISE EXCEPTION 'Network not found';
    END IF;
  END IF;
  DELETE FROM public.office_wifi_networks WHERE id = p_id;
  PERFORM public.sync_office_location_wifi_aggregates(v_office);
END;
$$;

CREATE OR REPLACE FUNCTION public.test_office_wifi_match(
  p_office_id UUID,
  p_client_ip TEXT,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  m RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) AND NOT public.is_demo_user(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT public.is_demo_user(v_uid) THEN
    v_company := public.current_company_id();
    IF NOT EXISTS (
      SELECT 1 FROM public.office_locations WHERE id = p_office_id AND company_id = v_company
    ) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  END IF;

  SELECT * INTO m FROM public.attendance_match_office_wifi(p_office_id, p_client_ip, p_ssid, p_bssid);

  RETURN jsonb_build_object(
    'matched', COALESCE(m.matched, false),
    'network_label', m.network_label,
    'network_id', m.network_id,
    'client_ip', p_client_ip,
    'ssid', p_ssid,
    'bssid', p_bssid,
    'ssid_only_suspected', COALESCE(m.ssid_only_suspected, false),
    'message', CASE
      WHEN COALESCE(m.matched, false) THEN format('Matched network: %s', m.network_label)
      ELSE 'No network matched'
    END
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.office_wifi_networks TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_office_wifi_networks(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_office_wifi_networks(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_office_wifi_network(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_office_wifi_match(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_office_location_wifi_aggregates(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
