# Wi‑Fi then radius check-in + any-location check-out — 2026-10-13

## Auto vs manual decision table

| | **Auto check-in** (Android + desktop) | **Manual Clock in** (dashboard / app) |
|---|---|---|
| **1. Office Wi‑Fi** | Connected to a **configured** office network for an **assigned** location (SSID / optional BSSID / public IP via `attendance_match_office_wifi`) → **check in**. **No radius required.** Public/arbitrary Wi‑Fi never counts. | Same: device reports office Wi‑Fi → allow without radius |
| **2. Else radius** | Not on office Wi‑Fi **and** GPS inside assigned location `radius_meters` (accuracy ≤ 100 m when provided) → **check in** | Same: require GPS inside assigned office radius |
| **3. Else** | No auto check-in | Reject (`not_on_office_wifi` / `outside_radius` / `need_fresh_location`) |
| **Window** | `[shift_start − 1h, shift_end]` | Same |
| **Both Wi‑Fi AND radius?** | **No** — either path alone is enough | **No** |
| **iOS** | Auto off | Manual Clock in still uses this RPC if location/Wi‑Fi available |
| **Check-out** | Early leave: **any** location in `[shift_start, shift_end)`; shift-end closer at end | Manual Clock out: any location in that window |

## Ordered rule (exact)

1. **On configured office Wi‑Fi** → check in (`match_via: wifi`). Radius not required.
2. **Else if GPS inside assigned location radius** → check in (`match_via: gps`).
3. **Else** → no check-in.

## Platforms

| Platform | Auto check-in | Manual Clock in |
|----------|----------------|-----------------|
| Android  | On (FGS + Wi‑Fi + GPS) | On |
| Desktop  | On (heartbeat + Wi‑Fi + GPS) | On (Wi‑Fi via IPC probe) |
| iOS      | Off | On (foreground) |
| Browser  | Configure only | On (GPS; Wi‑Fi SSID usually unavailable — IP may match if configured) |

## Migrations

- `supabase/migrations/wifi_auto_checkin_2026-10-13.sql`
- `supabase/migrations/auto_checkout_shift_end_2026-10-13.sql`
- `supabase/migrations/early_checkout_any_location_2026-10-13.sql`
- `supabase/migrations/wifi_radius_reentry_after_checkout_2026-10-13.sql`
- `supabase/migrations/manual_wifi_or_radius_checkin_2026-10-13.sql` (harden matcher + unstub manual geo Clock in/out)

## User must push / redeploy (agent does not)

- Git push of web/TS + docs + native/desktop sources
- DB already applied when `migrate:all` / this migration was run on the project
- **Redeploy edge** only if gateway stubs are stale (RPC body lives in DB)
- **Native rebuild**: Android + desktop Electron for Wi‑Fi probe on manual Clock in / auto path

## Honest gaps

- Browser rarely exposes SSID; manual path then relies on public IP match (if configured) or GPS radius.
- Desktop Wi‑Fi probe is best-effort (`netsh` / `nmcli`).
