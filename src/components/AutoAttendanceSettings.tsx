import { PauseCircle } from 'lucide-react';
import { ATTENDANCE_RULES_PAUSED_MESSAGE } from '../utils/attendanceRulesPaused';
import '../styles/auto-attendance-setup.css';

/**
 * Automatic attendance settings — clean placeholder while rules are rebuilt.
 * Wizard, device enrollment, Wi‑Fi matching, and toggles that drove old rules are removed from the UI.
 */
export default function AutoAttendanceSettings({
  mode = 'admin',
  embedded = false,
}: {
  mode?: 'admin' | 'self';
  embedded?: boolean;
}) {
  void mode;

  return (
    <div className="aas-root">
      <div className={`${embedded ? 'admin-office-card glass-panel' : 'glass-panel'} aas-panel aas-panel--paused`}>
        <div className="aas-panel__head">
          <div className="aas-panel__icon aas-panel__icon--muted">
            <PauseCircle size={18} />
          </div>
          <div>
            <h3 className="aas-panel__title">Automatic attendance</h3>
            <p className="aas-panel__subtitle">{ATTENDANCE_RULES_PAUSED_MESSAGE}</p>
          </div>
        </div>
        <p className="aas-paused-note">
          Setup, office Wi‑Fi matching, and device enrollment are turned off for now. Existing offices, shifts, and
          history are unchanged. New rules will appear here when they are ready.
        </p>
      </div>
    </div>
  );
}
