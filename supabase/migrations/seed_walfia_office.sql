-- Walfia office GPS zone — Arrant Technologies, Bahria Town Karachi
-- Coordinates from Google Maps: 25.0255035, 67.3043054

INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, active, is_demo)
SELECT
    'Walfia Office — Arrant Technologies',
    'Office 601 & 602, 6th Floor, Arqam Plaza, IV Midway Commercial A, near Bahria Head Office, Bahria Town Karachi, Pakistan',
    25.0255035,
    67.3043054,
    150,
    true,
    false
WHERE NOT EXISTS (
    SELECT 1 FROM public.office_locations
    WHERE name = 'Walfia Office — Arrant Technologies' AND is_demo = false
);

-- Update existing placeholder if migration was already applied with old Karachi coords
UPDATE public.office_locations
SET
    name = 'Walfia Office — Arrant Technologies',
    address = 'Office 601 & 602, 6th Floor, Arqam Plaza, IV Midway Commercial A, near Bahria Head Office, Bahria Town Karachi, Pakistan',
    latitude = 25.0255035,
    longitude = 67.3043054,
    radius_meters = 150,
    active = true,
    updated_at = timezone('utc'::text, now())
WHERE is_demo = false
  AND (
    name ILIKE '%HQ%'
    OR name ILIKE '%Walfia%'
    OR name ILIKE '%Demo Office%'
    OR (latitude BETWEEN 24.85 AND 24.87 AND longitude BETWEEN 66.99 AND 67.01)
  );

UPDATE public.office_locations
SET
    name = 'Demo Office — HQ',
    address = 'Office 601 & 602, Arqam Plaza, Bahria Town Karachi (demo sandbox)',
    latitude = 25.0255035,
    longitude = 67.3043054,
    radius_meters = 150,
    active = true,
    updated_at = timezone('utc'::text, now())
WHERE is_demo = true
  AND (latitude BETWEEN 24.85 AND 24.87 AND longitude BETWEEN 66.99 AND 67.01);
