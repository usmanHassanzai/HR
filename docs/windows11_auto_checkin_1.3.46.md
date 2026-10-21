# Windows 11 automatic check-in (desktop 1.3.46)

Windows 10, Linux, Android, iOS, and browsers keep the previous check-in behavior. Only Windows 11 (OS build 22000 or higher, any edition) changes.

Windows 10 already checks in without a separate background service. The desktop app calls `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`, creates a system-tray icon, and hides on close when that icon exists. The heartbeat runs in that process. `openAsHidden` does not hide a Windows window. Windows 11 uses the same login-item and tray process, and also passes `--hidden` and marks the startup entry enabled, because Windows 11 Task Manager otherwise turns startup off.

Windows 11 only:

- Wi-Fi is read from the WLAN API, then from `netsh` without depending on English labels (UTF-8, UTF-16, and OEM code pages), then from the connected profile name if the SSID is blank. SSID and BSSID are both sent.
- A failed or blank Wi-Fi read is not treated as leaving the office.
- After check-in, Wi-Fi drops and GPS “left the office” do not check out. The session closes at shift end or when the user clicks Clock Out.
- No check-in, check-out, Wi-Fi, reminder, or “left the office” notification, and no notification permission prompt.
- The app sends `platform_variant: 'windows11'`. Other clients omit that field.
- Diagnostics (Windows version and build, location, SSID, BSSID, public IP, saved-network match, last result, start-at-login, tray process) are shown in the app and appended to `wifi-diagnostics.log`.

The database functions `attendance_match_office_wifi`, `attendance_device_early_checkout`, and `process_auto_attendance_event` stay `SECURITY DEFINER` with a fixed `search_path`. The broader match and the stay-checked-in guard run only when `platform_variant` is `windows11`. A missing variant keeps the pre-2026-10-21 logic, including Windows 10 and Linux checkout on Wi-Fi drop. A Windows 11 match still has to be the person’s own company and assigned office.

Android and iOS native edits are on branch `native-phone-changes`, not in this desktop change.
