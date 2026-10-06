# R66 — Real-device attendance checklist

Run on physical devices before enabling automatic attendance for the whole company. Check each box.

Frozen reference shift for Arrant: **AC Shift 08:00–17:00 America/Chicago** → window **W = 07:00–18:00 CT**.

## Devices under test

- [ ] Android phone (background location + notifications + unrestricted battery)
- [ ] iPhone (Location **Always**; Background Modes → Location)
- [ ] Windows laptop (desktop app installed, tray icon visible)
- [ ] Linux laptop (desktop `.deb` installed)

## One-time enrollment

- [ ] Company toggles: phone and/or laptop auto attendance ON (admin)
- [ ] Per-user toggles ON for the test employee
- [ ] Office zone has GPS radius; for Wi-Fi tests also SSID/BSSID + public IP CIDR
- [ ] Phone: open app → Automatic attendance → read Play disclosure → Enable (one-time)
- [ ] Laptop: open desktop app while logged in → Enable automatic attendance
- [ ] Admin device list shows the new device (platform, TZ, not revoked)
- [ ] After logout from the dashboard, phone/laptop still sends events (device token)

## GPS (phone)

- [ ] Arrive at office **inside W** → auto check-in (`auto_gps`) without opening the dashboard
- [ ] Leave office **inside W** → auto check-out
- [ ] Arrive **61+ minutes before** shift start → nothing recorded; tracking idle
- [ ] Still on site after **W end** → visit closed; no new check-in until next W
- [ ] Mock location / fake GPS app → event rejected and appears under **Flagged attendance**

## Wi-Fi (phone)

- [ ] On office Wi-Fi inside W with GPS off / poor GPS → check-in via Wi-Fi when IP+BSSID match
- [ ] Same SSID from a different public IP (hotspot) → rejected / flagged (`fake_hotspot_suspected` or `wrong_network`)
- [ ] Admin **Test office Wi-Fi** button shows the public IP (and BSSID on Android when available)

## Laptop

- [ ] Power on at office network inside W → check-in (`laptop` / `auto_wifi`)
- [ ] Shut down / sleep long enough for stale presence → check-out
- [ ] Off office network → not checked in

## Multi-device

- [ ] Phone checks in; laptop heartbeat does not create a second open visit
- [ ] Second device can check out the open visit

## Manual / leave (regression)

- [ ] Manual clock in/out still works inside W for non-enrolled JWT geo path
- [ ] Leave approval creates a leave day **without** clock times
- [ ] Leave balances unchanged on reject; correct on approve

## Security / ops

- [ ] Forged `X-Forwarded-For: <office IP>` from outside office does **not** check in on Wi-Fi
- [ ] Revoke device → further events return `revoked_token`
- [ ] Flagged list shows mock / wrong network / outside window / clock skew

## Sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Tester | | | Pass / Fail |
| Admin | | | Pass / Fail |
