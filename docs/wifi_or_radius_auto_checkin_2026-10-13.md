# Wi‑Fi then radius auto check-in + any-location check-out — 2026-10-13

## Check-in vs check-out

| | **Check-in** | **Check-out** |
|---|---|---|
| **Where** | Office Wi‑Fi **first**, else office GPS radius | **Any** Wi‑Fi / **any** radius (location & network irrelevant) |
| **When** | `[shift_start − 1h, shift_end]` | `[shift_start, shift_end)` — early leave OK |
| **Rejected** | Outside that window; not on Wi‑Fi and outside radius | Before shift start; at/after shift end (except mass closer) |
| **Sessions** | One open session per user / attendance day | Closes the open session; never re-opens after checkout |
| **Platforms** | Android + Desktop; iOS off; browser configure only | Same device path; leave events + shift-end closer |

Manual Clock in/out RPCs remain paused.

## Ordered auto check-in rule

During **[shift_start − 1 hour, shift_end]** (assigned shift only), enrolled **Android** or **Desktop** devices auto check in with this **decision order** (not a random OR):

1. **Office Wi‑Fi first** — connected to any saved network for an **assigned** office location (SSID / optional BSSID / public IP) → **check in** (`match_via: wifi`).
2. **Else office radius** — if not on office Wi‑Fi, GPS inside that location’s `radius_meters` (location on; accuracy ≤ 100 m when provided) → **check in** (`match_via: gps`).
3. **Else** — do not check in.

Also:

- **One open session per user / attendance day** — further check-in events return `already_in` / `suppress_checkin` (no duplicate rows; never re-open after checkout).
- **iOS**: auto path off.
- **Web/browser**: configure Wi‑Fi + radius; no background auto check-in.

## Early / leave check-out (any location)

Client leave events (`exit`, `wifi_disconnected`, `leave`, `checkout`) while:

- device token valid,
- open attendance session,
- `now ∈ [shift_start, shift_end)`

→ **clock out at event time**. Server does **not** require office Wi‑Fi or radius match.

- **Before shift start** → `checkout_before_shift_start` (even if checked in during the early hour).
- **At/after shift end** → `checkout_after_shift_end`; the **shift-end mass closer** owns closing anyone still open.
- Laptop **suspend / power_off** does **not** early-checkout (lid close must not end the day).

Android: geofence EXIT + leaving assigned office Wi‑Fi (when already in).  
Desktop: leaving assigned office Wi‑Fi while checked in (heartbeat).  
Shift-end closer still runs for anyone still open at end.

## How Wi‑Fi is configured

On **Office location create/edit**:

- **SSID** (optional but recommended for Wi‑Fi path)
- **BSSID** / public IP optional
- Saved to `office_locations` aggregates + `office_wifi_networks`
- Wi‑Fi belongs to that **location**; only people **assigned** to it get auto check-in for that network/radius

## Device dedup / one check-in

Server `process_auto_attendance_event`: if the user already has an open `attendance_records` row (or open visit) for the attendance day, further **check-in** events return `action: already_in` **before** Wi‑Fi/GPS work. Clients stop spamming after `clock_in` / `already_in`. Leave events still flow for early checkout.

## Auto check-out at shift end

| Mechanism | Role |
|-----------|------|
| `close_open_attendance_if_shift_ended(user)` | Closes that user’s open day/visits when `now ≥ shift_end_utc` |
| `close_all_ended_shift_attendance()` | Mass closer for everyone still checked in |
| **pg_cron** job `scorr-close-ended-shifts` (`* * * * *`) | Preferred when `pg_cron` is enabled |
| Edge `attendance-schedule` `action: close_ended_shifts` | Fallback cron invoke (service role or `ATTENDANCE_CRON_SECRET`) |
| Schedule / event opportunistic close | Self-close on schedule fetch + before check-in/out evaluate |

**Shift-end checkout time rule:** `clock_out_at = GREATEST(clock_in_at, shift_end_utc)`.  
**Early checkout time rule:** `clock_out_at = event time` (clamped to open session, still before shift end).

## Platforms

| Platform | Auto check-in | Early leave checkout |
|----------|----------------|----------------------|
| Android  | On (FGS + Wi‑Fi + GPS; suppresses after success) | Geofence EXIT + office Wi‑Fi leave |
| Desktop  | On (Electron heartbeat + Wi‑Fi + GPS) | Office Wi‑Fi leave while checked in |
| iOS      | Off | Off |
| Browser  | Configure only | — |

## Migrations

- `supabase/migrations/wifi_auto_checkin_2026-10-13.sql`
- `supabase/migrations/auto_checkout_shift_end_2026-10-13.sql` (ordered Wi‑Fi→radius + shift-end closer + cron)
- `supabase/migrations/early_checkout_any_location_2026-10-13.sql` (leave checkout without office match; window `[start, end)`)
- Listed in `scripts/apply-all-migrations.mjs`

## User must push / redeploy (agent does not)

- Git push of web/TS + docs + native sources
- **Redeploy edge** `attendance-schedule` / `auto-attendance-event` only if those gateway stubs are still old (RPC body lives in DB)
- If **pg_cron is not** on the project: schedule a minute cron that POSTs  
  `{ "action": "close_ended_shifts" }` to `attendance-schedule` with the service role JWT (or `x-cron-secret`).
- **Native rebuild**: Android **versionCode 30 / 1.3.23**, desktop Electron publish

## Honest gaps

- Prod historically had **no pg_cron**; until cron or edge schedule is wired, mass checkout still runs opportunistically when devices hit schedule/events, but people with no device activity after shift end need the cron.
- Desktop Wi‑Fi SSID probe is best-effort (`netsh` / `nmcli`). Desktop GPS-only check-ins without office Wi‑Fi rely on shift-end closer for auto out (no geofence).
