-- attendance_auto_tests.sql
-- Prefer the deterministic runner (frozen "now", per-case PASS/FAIL):
--   node scripts/run-attendance-auto-tests.mjs
--
-- That runner uses FROZEN now = 2026-10-06 15:00:00+00 inside a rolled-back
-- transaction (no production schema/data left behind).
--
-- This file is kept as a pointer so migration tooling does not re-apply the
-- old wall-clock-dependent suite that printed only "OK []".
SELECT 'Use scripts/run-attendance-auto-tests.mjs' AS attendance_auto_tests_note;
