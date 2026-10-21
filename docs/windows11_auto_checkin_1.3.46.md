# Windows 11 automatic check-in (desktop 1.3.46)

Windows 10 (any edition, build 21999 or lower), Linux, Android, iOS, and browsers keep the desktop and shared web behavior from main. Only Windows 11 (OS build 22000 or higher, any edition) changes. The edition name is never read.

Windows 10 already checks in without a separate background service. The desktop app calls `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`, creates a system-tray icon, and hides on close when that icon exists. The heartbeat runs in that process. Windows 11 uses that same login-item and tray process, and also passes `--hidden` and marks the startup entry enabled.

Windows 11 only:

- Wi-Fi is read from the WLAN API, then from `netsh` without English labels (UTF-8, UTF-16, and OEM code pages), then from the connected profile name if the SSID is blank. SSID and BSSID are both sent.
- A failed or blank Wi-Fi read is not treated as leaving the office.
- After check-in, Wi-Fi drops and GPS “left the office” do not check out. The session closes at shift end or when the user clicks Clock Out.
- The check-in toast is off. Check-out, shift-end (the check-out toast), and reminders stay as in 1.3.45. Wi-Fi-change and “left the office” toasts stay off because those events no longer check anyone out.
- The app sends `platform_variant: 'windows11'`. Other clients omit that field.
- Diagnostics (Windows version and build, location, SSID, BSSID, public IP, saved-network match, last result, start-at-login, tray process) are shown in the desktop window and appended to `wifi-diagnostics.log`. If Location is off and the name is hidden, the panel offers a button that opens Windows Location settings.

The database functions `attendance_match_office_wifi`, `attendance_device_early_checkout`, and `process_auto_attendance_event` stay `SECURITY DEFINER` with a fixed `search_path`. The broader match and the stay-checked-in guard run only when `platform_variant` is `windows11`. A missing variant keeps the pre-2026-10-21 logic. `attendance_match_office_wifi_windows11` is not granted to `authenticated`. Only `process_auto_attendance_event` calls it, and that function is `SECURITY DEFINER`.

Open sessions at shift end are closed by the existing `close_all_ended_shift_attendance`. This change does not add a second closer.

Android and iOS native files are not part of this branch.
