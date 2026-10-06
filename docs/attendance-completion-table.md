# Automatic attendance completion table (one row per ID)

Status as of 2026-10-06 local work. **Web/native not deployed** unless noted. DB/edges live on prod.

| ID | Done | Notes |
|----|------|-------|
| R1 | Partial | JWT geo path live; device-token native path in commits only |
| R2 | Yes | Shared window on writers/geo/leave (DB live) |
| R3 | Yes | Shift IANA TZ fields (DB live) |
| R4 | Partial | Clients coded; builds not store-released with new path |
| R5 | Yes | 17 migrations applied to prod |
| R6 | Yes | `attendance_window_for_user` |
| R7 | Yes | W = [start−60, end+60] |
| R8 | Yes | Outside W → no write / stop_tracking |
| R9 | Yes | Server time for gating |
| R10 | Yes | Skew correction helper |
| R11 | Yes | Event too old (>15m) |
| R12 | Yes | Mock location reject |
| R13 | Yes | Feature toggles default OFF |
| R14 | Yes | Work mode remote gate |
| R15 | Yes | Cron closers coded (`pg_cron` extension **not** on prod) |
| R16 | Yes | Enforcement triggers |
| R17 | Yes | RLS lockdown client writes |
| R18 | Yes | Events log table |
| R19 | Yes | Corrections audit table |
| R20 | Yes | Company timezone |
| R21 | Yes | Shift timezone |
| R22 | Yes | Dual TZ display helpers (client) |
| R23 | Yes | Arrant AC Shift → Chicago 8–5 |
| R24 | Partial | Morning Shift demo left Karachi — awaiting your decision |
| R25 | Yes | `get_my_attendance_schedule` / token schedule |
| R26 | Yes | Edge `attendance-schedule` deployed |
| R27 | Yes | Native schedule sync coded |
| R28 | Yes | `attendance_devices` |
| R29 | Yes | Register device RPC + edge |
| R30 | Yes | Secure token storage (native/Electron) |
| R31 | Yes | Revoke device |
| R32 | Yes | List devices / unenrolled |
| R33 | Yes | Token hash only server-side |
| R34 | Yes | Disable on device |
| R35 | Yes | Android geofence (code) |
| R36 | Yes | Android W alarms (code) |
| R37 | Yes | Android FGS W-only (code) |
| R38 | Yes | Android Wi-Fi callbacks (code) |
| R39 | Yes | Android boot resume (code) |
| R40 | Yes | Android battery guidance (UI text) |
| R41 | Yes | Android disclosure screen (UI) |
| R42 | Yes | Android Wi-Fi identity (code) |
| R43 | Yes | Android event client (code) |
| R44 | Yes | iOS region monitoring (code; **not compiled here — no Mac**) |
| R45 | Yes | Electron tray/heartbeat (code) |
| R46 | Yes | Electron power on/off (code) |
| R47 | Yes | Electron safeStorage token (code) |
| R48 | Yes | Electron office network (code) |
| R49 | Yes | Electron schedule sync (code) |
| R50 | Yes | Desktop build scripts |
| R51 | Partial | Desktop rebuild in progress this session |
| R52 | Yes | Preload isolation |
| R53 | Yes | Desktop ↔ edge event path |
| R54 | Yes | `process_auto_attendance_event` live |
| R55 | Partial | Edge deployed; R73 IP fix **local only** (rightmost XFF) — not redeployed |
| R56 | Yes | Multi-device presence |
| R57 | Yes | Heartbeat / stale close (RPC; cron not scheduled) |
| R58 | Yes | Close at W end (RPC; cron not scheduled) |
| R59 | Partial | Toggles/device list/opt-in/Wi-Fi fields done; Flagged list + Test Wi-Fi + Play disclosure added in local UI — **not in prod web** |
| R60 | Yes | Fixed-now tests PASS (`scripts/run-attendance-auto-tests.mjs`) |
| R61 | Yes | Fixed-now tests PASS |
| R62 | Yes | All listed cases PASS |
| R63 | Yes | All listed cases PASS |
| R64 | Yes | Company isolation in schema/tests |
| R65 | Partial | Docs/PDF generators previously updated |
| R66 | Yes | `docs/attendance-device-checklist.md` (you run) |
| R67 | Partial | Rollout: toggles OFF by default live |
| R68 | No | Full company enable not done |
| R69 | Partial | Prod health verified this session |
| R70 | Yes | Rollback SQL prepared, not applied |
| R71 | No | PITR off; no backup timestamp from API |
| R72 | Partial | Manual check-in broken by realign+guard (fix SQL awaiting apply) |
| R73 | Partial | Rightmost XFF + unit tests local; edge not redeployed |
| R74 | Yes | No deploy/push without approval (standing rule) |
| R75 | Yes | Early Wi-Fi rejected PASS |
| N1 | Yes | geo→auto_gps backfill done |
| N2 | Yes | JWT geo until enroll |
| N3 | Yes | Enrolled prefers device-token |
| N4 | Partial | Silent path after logout coded; not in prod clients |
| R76 | Yes (local) | Multi-zone shift form + IANA picker; migration not applied |
| R77 | Yes (local) | `shift_display_zones` + upsert args in `shift_display_zones_NOT_APPLIED.sql` |
| R78 | Yes (local) | DST/half-hour math via Intl; spring-forward rule documented; form DST notices |
| R79 | Yes (local) | Multi-zone display line, +1 day labels, exports per-zone columns, My shift card |
| R80 | Yes (local) | Office default TZ fields + `update_office_default_timezones` (migration not applied) |
| R81 | Yes | `scripts/run-shift-multizone-tests.mjs` — 23 PASS / 0 FAIL |
