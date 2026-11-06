import { useEffect, useState } from 'react';
import {
  attendanceNotificationsEnabled,
  setAttendanceNotificationsEnabled,
  syncAttendanceNotificationPref,
} from '../utils/attendanceNotificationPref';

export default function AttendanceNotificationSetting() {
  const [on, setOn] = useState(attendanceNotificationsEnabled);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void syncAttendanceNotificationPref();
  }, []);

  const toggle = async () => {
    const next = !on;
    setBusy(true);
    setOn(next);
    try {
      await setAttendanceNotificationsEnabled(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="app-settings-block" open>
      <summary>Notifications</summary>
      <p className="attendance-notify-setting__copy">
        Check-in and check-out alerts stay off until you turn them on. This covers the website,
        Windows, Linux, and the phone, including when you are away from the office.
      </p>
      <label className="attendance-notify-setting__row">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={() => void toggle()}
        />
        <span>Show check-in and check-out notifications</span>
      </label>
    </details>
  );
}
