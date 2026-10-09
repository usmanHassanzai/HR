# Scorr attendance — complete investigation

**Date:** 2026-10-09 / 2026-10-10 (Asia/Karachi)  
**Mode:** Survey only. No code, migrations, config, or data changes.  
**Method:** Repository reads + production SELECT / `pg_get_functiondef` / catalog queries.

---

## PHASE 1 — Coverage list

Numbered list of files that touch attendance scope. Status column filled as the investigation proceeds (`READ` = examined for this survey).

### Client — React / utils (`src/`)

| # | File | Role | Status |
|---|------|------|--------|
| 1 | `src/App.tsx` | Mounts SilentGeoAttendance; app shell | |
| 2 | `src/PortalApp.tsx` | Lazy GeoAttendanceTracker; portal routes | |
| 3 | `src/components/SilentGeoAttendance.tsx` | Arms native/iOS Home/desktop/web backgrounded after token | |
| 4 | `src/components/GeoAttendanceTracker.tsx` | Dashboard JWT geo ping / hold | |
| 5 | `src/components/GeoAttendancePanel.tsx` | Manual Clock in/out, visit list, shift duration UI | |
| 6 | `src/components/AttendanceLeavePanel.tsx` | My day, leave, check-out UI, tabs | |
| 7 | `src/components/AttendanceHistoryRecords.tsx` | History table rendering | |
| 8 | `src/components/EmployeeAttendanceHistory.tsx` | Employee history + CSV | |
| 9 | `src/components/AdminAttendanceDirectory.tsx` | Admin/HR team history | |
| 10 | `src/components/ManagerTeamAttendanceDirectory.tsx` | Manager team history | |
| 11 | `src/components/AttendanceMonthWiseList.tsx` | Month buckets of duration | |
| 12 | `src/components/AutoAttendanceSetupWizard.tsx` | Device enrollment wizard | |
| 13 | `src/components/AutoAttendanceSettings.tsx` | Admin auto-attendance company settings | |
| 14 | `src/components/OfficeLocationSettings.tsx` | Office pin, radius, Wi‑Fi networks | |
| 15 | `src/components/ShiftManagementPanel.tsx` | Shifts CRUD (admin); location window card | |
| 16 | `src/components/MyShiftCard.tsx` | Employee shift status card | |
| 17 | `src/components/AssignManagerLocationPanel.tsx` | Manager office inheritance | |
| 18 | `src/components/AdminLiveTracking.tsx` | Live GPS matrix | |
| 19 | `src/components/LiveGpsCapture.tsx` | GPS capture helper | |
| 20 | `src/components/MapLocationPicker.tsx` | Map pin picker for office | |
| 21 | `src/components/Analytics.tsx` | Attendance stats (history RPC) | |
| 22 | `src/components/EmployeeDashboard.tsx` | Embeds attendance panels | |
| 23 | `src/components/ManagerDashboard.tsx` | Manager attendance nav | |
| 24 | `src/components/AdminDashboard.tsx` | Admin attendance nav | |
| 25 | `src/components/HrDashboard.tsx` | HR attendance | |
| 26 | `src/components/AdminUsersPage.tsx` | User work_mode / auto flags | |
| 27 | `src/components/AdminEditUserModal.tsx` | Edit user attendance-related fields | |
| 28 | `src/components/AdminUserHubModal.tsx` | User hub | |
| 29 | `src/components/CompanySetupWizard.tsx` | Company setup including office | |
| 30 | `src/components/Login.tsx` | Visibility; post-login arm | |
| 31 | `src/components/AppUpdateBanner.tsx` | Version nudge (affects native builds) | |
| 32 | `src/components/MobileAppDownload.tsx` | App download links | |
| 33 | `src/components/DeleteAccountSection.tsx` | May revoke devices | |
| 34 | `src/components/DeleteAccountPage.tsx` | Account delete | |
| 35 | `src/components/LandingPage.tsx` | Marketing mentions | |
| 36 | `src/components/Header.tsx` | Nav | |
| 37 | `src/components/AdminSidebarNav.tsx` | Admin nav items | |
| 38 | `src/utils/geoAttendance.ts` | `process_geo` RPC wrapper, visit types | |
| 39 | `src/utils/attendanceDevice.ts` | Device token, schedule, auto-event POST | |
| 40 | `src/utils/attendanceNativePing.ts` | Capacitor AttendancePing plugin bridge | |
| 41 | `src/utils/attendanceIosHome.ts` | iOS Home Screen polling | |
| 42 | `src/utils/attendanceAppBackgrounded.ts` | Web/Home `app_backgrounded` beacon | |
| 43 | `src/utils/attendanceStaleQueue.ts` | Client event freshness (10 min) | |
| 44 | `src/utils/attendanceBackgroundSession.ts` | Geo hold after logout | |
| 45 | `src/utils/autoAttendanceSetup.ts` | Wizard RPCs, battery tips | |
| 46 | `src/utils/shiftHelpers.ts` | Windows, duration display, history describe | |
| 47 | `src/utils/shiftMultiZone.ts` | Multi-zone shift helpers | |
| 48 | `src/utils/exportAttendance.ts` | CSV export | |
| 49 | `src/utils/attendanceHelpers.ts` | Status/approval labels | |
| 50 | `src/utils/attendancePeriod.ts` | Month period buckets | |
| 51 | `src/utils/attendanceEmail.ts` | Attendance email helpers | |
| 52 | `src/utils/reconcileAttendance.ts` | Client reconcile helpers | |
| 53 | `src/utils/workModeHelpers.ts` | Office vs remote GPS | |
| 54 | `src/utils/nativePlatform.ts` | Platform detection (iOS Home, desktop) | |
| 55 | `src/utils/presenceHeartbeat.ts` | Portal presence (not office attendance) | |
| 56 | `src/utils/usePortalSessionGuard.ts` | Session + location window | |
| 57 | `src/utils/notificationHelpers.ts` | Pending attendance notify | |
| 58 | `src/utils/notificationNavigation.ts` | Notify deep links | |
| 59 | `src/utils/appUpdate.ts` | Version compare | |
| 60 | `src/utils/trustedDevice.ts` | MFA trusted device (adjacent) | |
| 61 | `src/styles/attendance.css` | Attendance UI styles | |
| 62 | `src/styles/admin-attendance.css` | Admin attendance styles | |
| 63 | `src/styles/employee-attendance.css` | Employee styles | |
| 64 | `src/styles/manager-attendance.css` | Manager styles | |
| 65 | `src/styles/admin-office.css` | Office settings styles | |
| 66 | `src/styles/auto-attendance-setup.css` | Wizard styles | |

### Edge functions (`supabase/functions/`)

| # | File | Role | Status |
|---|------|------|--------|
| 67 | `supabase/functions/auto-attendance-event/index.ts` | Device-token → `process_auto_attendance_event` | |
| 68 | `supabase/functions/attendance-schedule/index.ts` | Schedule sync for devices | |
| 69 | `supabase/functions/register-attendance-device/index.ts` | Device registration edge | |
| 70 | `supabase/functions/_shared/trustedClientIp.ts` | Proxy IP extraction | |
| 71 | `supabase/functions/_shared/trustedClientIp_test.ts` | IP unit tests | |
| 72 | `supabase/functions/trusted_device/index.ts` | MFA device (adjacent) | |

### Android native

| # | File | Role | Status |
|---|------|------|--------|
| 73 | `android/app/src/main/java/ai/walfia/scorr/AttendancePingService.java` | FGS heartbeat / GPS / Wi‑Fi | |
| 74 | `android/app/src/main/java/ai/walfia/scorr/AttendanceEventClient.java` | HTTP queue to edge | |
| 75 | `android/app/src/main/java/ai/walfia/scorr/AttendancePingStore.java` | Local prefs/cache | |
| 76 | `android/app/src/main/java/ai/walfia/scorr/AttendanceScheduleController.java` | Window arm / sync | |
| 77 | `android/app/src/main/java/ai/walfia/scorr/AttendanceGeofenceManager.java` | Geofence register | |
| 78 | `android/app/src/main/java/ai/walfia/scorr/AttendanceGeofenceReceiver.java` | ENTER/EXIT | |
| 79 | `android/app/src/main/java/ai/walfia/scorr/AttendanceBootReceiver.java` | Boot / update / FGS restart | |
| 80 | `android/app/src/main/java/ai/walfia/scorr/AttendanceWindowReceiver.java` | Window start/end alarms | |
| 81 | `android/app/src/main/java/ai/walfia/scorr/AttendanceScheduleWorker.java` | WorkManager sync | |
| 82 | `android/app/src/main/java/ai/walfia/scorr/AttendancePingPlugin.java` | Capacitor plugin | |
| 83 | `android/app/src/main/AndroidManifest.xml` | FGS, permissions, receivers | |
| 84 | `android/app/build.gradle` | versionCode / versionName | |

### iOS native

| # | File | Role | Status |
|---|------|------|--------|
| 85 | `ios/App/App/AttendancePingPlugin.swift` | Regions, SLC, NWPathMonitor, queue | |
| 86 | `ios/App/App.xcodeproj/project.pbxproj` | MARKETING_VERSION | |
| 87 | `ios/App/App/Info.plist` | Location / background modes (if present) | |

### Desktop (Electron)

| # | File | Role | Status |
|---|------|------|--------|
| 88 | `desktop/main.cjs` | Tray, heartbeat, sleep/wake, app_quit | |
| 89 | `desktop/preload.cjs` | IPC bridge | |
| 90 | `desktop/package.json` | Desktop version | |
| 91 | `desktop/electron-builder.yml` | Build config | |
| 92 | `desktop/README.md` | Desktop notes | |

### Migrations (attendance-related; full set in apply-all)

Key rule / device / office / shift migrations (non-exhaustive of every FIX; apply-all lists order):

| # | File | Role | Status |
|---|------|------|--------|
| 93 | `supabase/migrations/geo_attendance.sql` | Core geo tables/RPCs origin | |
| 94 | `supabase/migrations/attendance_devices.sql` | Devices table | |
| 95 | `supabase/migrations/attendance_events_log.sql` | Events log | |
| 96 | `supabase/migrations/attendance_settings.sql` | Company settings | |
| 97 | `supabase/migrations/attendance_cron.sql` | Cron wiring | |
| 98 | `supabase/migrations/attendance_auto_rpc.sql` | Auto RPC base | |
| 99 | `supabase/migrations/attendance_window_core.sql` | Window helpers | |
| 100 | `supabase/migrations/attendance_geo_window.sql` | Geo window | |
| 101 | `supabase/migrations/office_wifi_networks_*.sql` | Office networks | |
| 102 | `supabase/migrations/office_radius_*.sql` | Radius | |
| 103 | `supabase/migrations/employee_office_assignment.sql` | Assignments | |
| 104 | `supabase/migrations/shift_attendance*.sql` | Shifts | |
| 105 | `supabase/migrations/overnight_shift_attendance_date.sql` | Overnight date | |
| 106 | `supabase/migrations/attendance_rules_5b_5c_2026-10-09.sql` | 5b/5c | |
| 107 | `supabase/migrations/attendance_ios_silence_rule5_2026-10-09.sql` | iOS silence | |
| 108 | `supabase/migrations/attendance_laptop_rules_2026-10-09.sql` | Laptop L1–L6 | |
| 109 | `supabase/migrations/attendance_rule_6_2026-10-09.sql` | Rule 6 | |
| 110 | `supabase/migrations/attendance_rule_1_7_2026-10-09.sql` | Rules 1/7 | |
| 111 | `supabase/migrations/attendance_rule_2_overnight_early_2026-10-09.sql` | Overnight early | |
| 112 | `supabase/migrations/attendance_immediate_inout_2026-10-09.sql` | Immediate in/out | |
| 113 | `supabase/migrations/attendance_checkin_wifi_no_gps_2026-10-09.sql` | Wi‑Fi no GPS | |
| 114 | `supabase/migrations/attendance_manual_checkout_wifi_no_gps_2026-10-09.sql` | Manual Wi‑Fi out | |
| 115 | `supabase/migrations/attendance_false_checkout_fix_2026-10-09.sql` | False checkout | |
| 116 | `supabase/migrations/attendance_reentry_tracking_2026-10-09.sql` | Re-entry keep tracking | |
| 117 | `supabase/migrations/attendance_zero_minute_loop_fix_2026-10-09.sql` | Zero-min loop | |
| 118 | `supabase/migrations/attendance_app_close_not_leave_2026-10-10.sql` | App background grace | |
| 119 | `supabase/migrations/attendance_shift_duration_sum_2026-10-10.sql` | Duration SSOT | |
| 120 | `supabase/migrations/FIX_checkout_*.sql` / `FIX_shift_*.sql` / `FIX_checkin_*.sql` | Layered FIX migrations | |
| 121 | `supabase/migrations/geo_auto_reenter_attendance.sql` | Re-enter | |
| 122 | `supabase/migrations/attendance_enforcement_triggers.sql` | Guard triggers | |
| 123 | `supabase/migrations/attendance_rls_lockdown.sql` | RLS | |
| 124 | `supabase/migrations/auto_attendance_setup_wizard_2026-10-07.sql` | Wizard RPCs | |
| 125 | `supabase/migrations/attendance_leave*.sql` | Leave | |
| 126 | `supabase/migrations/attendance_correction_rpc.sql` | Admin correction | |
| 127 | Many other `*attendance*`, `*office*`, `*shift*`, `*geo*` under `supabase/migrations/` | Historical layers | |

### Scripts / public / package

| # | File | Role | Status |
|---|------|------|--------|
| 128 | `scripts/apply-all-migrations.mjs` | Migration apply order | |
| 129 | `scripts/deploy-live.mjs` | Live deploy (runs migrations) | |
| 130 | `scripts/test-attendance-*.mjs` | Local/ROLLBACK tests | |
| 131 | `scripts/test-edge-attendance-ip.mjs` | Edge IP test | |
| 132 | `scripts/generate-attendance-guide-pdf.mjs` | Guide PDF | |
| 133 | `public/build-meta.json` | Web build id | |
| 134 | `public/downloads/version.json` | Download versions | |
| 135 | `public/downloads/Scorr-Attendance-Guide.pdf` | User guide | |
| 136 | `package.json` | Root version 1.3.19; scripts | |

**Phase 1 note:** ~114 migration filenames match attendance/shift/office/geo/device keywords; the table above highlights the active rule stack. Full apply-all order is in Phase 2.

---

