import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import {
  AlertTriangle,
  BatteryCharging,
  Bell,
  CheckCircle2,
  Circle,
  Laptop,
  Loader2,
  MapPin,
  RefreshCw,
  Shield,
  Smartphone,
  Wifi,
  XCircle,
} from 'lucide-react';
import {
  batteryTips,
  clearSetupProgress,
  fetchSetupStatus,
  getNativePermissionSnapshot,
  isDesktopApp,
  isDeviceAlreadyEnrolled,
  isNativeApp,
  loadSetupProgress,
  openNativeAppSettings,
  openNativeBatterySettings,
  probeOfficeNetworkMatch,
  registerDeviceViaRpc,
  requestAlwaysLocation,
  requestNativeNotifications,
  requestWhileUsingLocation,
  saveSetupProgress,
  type SetupStatus,
} from '../utils/autoAttendanceSetup';
import {
  disableAutoAttendanceOnDevice,
  PHONE_OPT_IN_TEXT,
  sendAutoAttendanceEventWithLocation,
} from '../utils/attendanceDevice';
import { isAndroidApp, isIosApp, isIosHomeScreen, isIosPhoneClient } from '../utils/nativePlatform';
import { startNativeAttendancePings } from '../utils/attendanceNativePing';
import { startIosHomeAttendance } from '../utils/attendanceIosHome';
import '../styles/auto-attendance-setup.css';

type StepStatus = 'waiting' | 'busy' | 'done' | 'action' | 'failed';

type StepDef = {
  id: string;
  title: string;
  explanation: string;
  icon: typeof MapPin;
};

function statusLabel(s: StepStatus): string {
  switch (s) {
    case 'busy':
      return 'Working…';
    case 'done':
      return 'Done ✓';
    case 'action':
      return 'Needs action ⚠';
    case 'failed':
      return 'Failed ✕';
    default:
      return 'Waiting';
  }
}

function statusClass(s: StepStatus): string {
  return `aas-status aas-status--${s === 'busy' ? 'busy' : s}`;
}

export default function AutoAttendanceSetupWizard({
  onClose,
  onFinished,
  /** Keep the wizard/status card inside Settings — never cover sibling sections. */
  inline = true,
  /** When enrolled: show only the compact ON status card (no step UI, never fullscreen). */
  statusOnly = false,
  /** Parent switches from status card → setup steps (e.g. “Fix a problem”). */
  onFixProblem,
}: {
  onClose?: () => void;
  onFinished?: () => void;
  inline?: boolean;
  statusOnly?: boolean;
  onFixProblem?: () => void;
}) {
  const native = isNativeApp();
  const iosHome = isIosHomeScreen();
  const phoneClient = native || iosHome;
  const desktop = isDesktopApp();
  // Settings embeds status + steps as an inline card. Never use aas-wizard--fullscreen —
  // that overlay hid Change password / Account security / Delete account on native.
  void inline;

  const steps: StepDef[] = useMemo(() => {
    if (desktop) {
      return [
        { id: 'account', title: 'Your account is ready', explanation: 'Checking company settings, office zone, and shift.', icon: Shield },
        { id: 'autolaunch', title: 'Start Scorr when the computer starts', explanation: 'Keeps laptop attendance working after reboot.', icon: Laptop },
        { id: 'network', title: 'Office network and location', explanation: 'Check-in needs office Wi-Fi and a GPS reading inside the office radius. Either one alone is not enough.', icon: Wifi },
        { id: 'register', title: 'Register this laptop', explanation: 'Securely enrolls this device for automatic attendance.', icon: CheckCircle2 },
      ];
    }
    const base: StepDef[] = [
      {
        id: 'disclosure',
        title: 'Why Scorr needs your location',
        explanation: isIosPhoneClient()
          ? 'Apple requires a clear explanation before location is used — read before continuing.'
          : 'Google Play prominent disclosure — read before continuing.',
        icon: MapPin,
      },
      { id: 'account', title: 'Your account is ready', explanation: 'Checking company settings, office zone, and shift.', icon: Shield },
      {
        id: 'location',
        title: 'Location access',
        explanation: iosHome
          ? 'This Home Screen app cannot run in the background. Scorr checks location when you open it, and every 60 seconds while it stays open.'
          : isIosApp()
            ? 'Allow While Using, then Always. A geofence exit checks you out when you leave the office, even if the app is closed.'
            : 'Allow all the time, and set battery to Unrestricted, so a geofence exit can check you out in the background.',
        icon: MapPin,
      },
      { id: 'notifications', title: 'Notifications', explanation: 'So you know when you are checked in or out.', icon: Bell },
    ];
    if (isAndroidApp()) {
      base.push({
        id: 'battery',
        title: 'Keep Scorr running',
        explanation: 'Set battery to Unrestricted so background location and check-out keep running during the shift.',
        icon: BatteryCharging,
      });
    }
    base.push({
      id: 'register',
      title: 'Register this phone',
      explanation: 'Securely enrolls this device for automatic attendance.',
      icon: Smartphone,
    });
    return base;
  }, [desktop, iosHome]);

  const totalSteps = steps.length;
  const [stepIndex, setStepIndex] = useState(() => Math.min(loadSetupProgress(), Math.max(0, totalSteps - 1)));
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({});
  const [busyText, setBusyText] = useState('');
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [manufacturer, setManufacturer] = useState('');
  const [networkMsg, setNetworkMsg] = useState('');
  const [finished, setFinished] = useState(statusOnly);
  const [finishMeta, setFinishMeta] = useState<{
    status: string;
    lastCheck: string;
    testResult: string;
  }>({ status: '—', lastCheck: '—', testResult: '' });

  const current = steps[stepIndex];

  const setStepStatus = useCallback((id: string, st: StepStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: st }));
  }, []);

  const goTo = useCallback(
    (idx: number) => {
      const next = Math.max(0, Math.min(idx, steps.length - 1));
      setStepIndex(next);
      saveSetupProgress(next);
      setError('');
      setBusyText('');
    },
    [steps.length],
  );

  const runWithBusy = useCallback(
    async (id: string, label: string, fn: () => Promise<void>) => {
      setError('');
      setBusyText(label);
      setStepStatus(id, 'busy');
      try {
        await fn();
      } catch (e) {
        setStepStatus(id, 'failed');
        setError(e instanceof Error ? e.message : String(e));
        setBusyText('');
        throw e;
      } finally {
        setBusyText('');
      }
    },
    [setStepStatus],
  );

  const checkAccount = useCallback(async () => {
    await runWithBusy('account', 'Checking your account…', async () => {
      const st = await fetchSetupStatus();
      setSetup(st);
      if (!st.ok) {
        setStepStatus('account', 'failed');
        setError(st.issues.join(' '));
        return;
      }
      setStepStatus('account', 'done');
      goTo(steps.findIndex((s) => s.id === 'account') + 1);
    });
  }, [goTo, runWithBusy, setStepStatus, steps]);

  const refreshPermissions = useCallback(async () => {
    if (!phoneClient) return;
    try {
      const snap = await getNativePermissionSnapshot();
      setManufacturer(snap.manufacturer || '');
      const locOk = snap.location === 'granted' || snap.coarseLocation === 'granted';
      const bgOk = snap.backgroundLocation === 'granted';
      const preciseOk = snap.precise !== false;
      const servicesOk = snap.locationServicesEnabled !== false;
      if (current?.id === 'location') {
        if (locOk && bgOk && preciseOk && servicesOk) {
          setStepStatus('location', 'done');
          setError('');
          goTo(stepIndex + 1);
        } else if (locOk && !bgOk) {
          setStepStatus('location', 'action');
          setError(
            isAndroidApp()
              ? 'Tap Permissions → Location → Allow all the time, then return here.'
              : 'Open Settings and set Location to Always, then return here.',
          );
        } else if (!servicesOk) {
          setStepStatus('location', 'action');
          setError('Turn on Location services on this phone, then return here.');
        } else if (!preciseOk) {
          setStepStatus('location', 'action');
          setError('Turn on Precise location for Scorr, then return here.');
        }
      }
      if (current?.id === 'notifications' && snap.notifications === 'granted') {
        setStepStatus('notifications', 'done');
        goTo(stepIndex + 1);
      }
      if (current?.id === 'battery' && snap.batteryUnrestricted) {
        setStepStatus('battery', 'done');
        goTo(stepIndex + 1);
      }
    } catch {
      /* ignore resume failures */
    }
  }, [current?.id, goTo, phoneClient, setStepStatus, stepIndex]);

  useEffect(() => {
    if (statusOnly) {
      setFinished(true);
      clearSetupProgress();
      return;
    }
    void isDeviceAlreadyEnrolled().then((ok) => {
      if (ok) {
        setFinished(true);
        clearSetupProgress();
      }
    });
  }, [statusOnly]);

  useEffect(() => {
    if (!phoneClient) return;
    let handle: { remove: () => Promise<void> } | undefined;
    if (native) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void refreshPermissions();
      }).then((h) => {
        handle = h;
      });
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshPermissions();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      void handle?.remove();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [native, phoneClient, refreshPermissions]);

  const continueDisclosure = () => {
    setStepStatus('disclosure', 'done');
    goTo(1);
  };

  const requestLocation = async () => {
    await runWithBusy('location', 'Waiting for location permission…', async () => {
      const whileUsing = await requestWhileUsingLocation();
      if (!whileUsing.ok) {
        setStepStatus('location', 'action');
        setError(whileUsing.detail);
        return;
      }
      if (iosHome) {
        setStepStatus('location', 'done');
        goTo(stepIndex + 1);
        return;
      }
      if (isIosApp()) {
        const always = await requestAlwaysLocation();
        if (always.ok) {
          setStepStatus('location', 'done');
          goTo(stepIndex + 1);
          return;
        }
        setStepStatus('location', 'action');
        setError(always.detail || 'Open Settings → Scorr → Location → Always, then return here.');
        return;
      }
      // Android 10+: Always cannot be granted from a dialog — open settings.
      setStepStatus('location', 'action');
      setError('Tap Permissions → Location → Allow all the time, then return here.');
    });
  };

  const requestNotifs = async () => {
    await runWithBusy('notifications', 'Waiting for notification permission…', async () => {
      const res = await requestNativeNotifications();
      if (!res.ok) {
        setStepStatus('notifications', 'action');
        setError(res.detail);
        return;
      }
      setStepStatus('notifications', 'done');
      goTo(stepIndex + 1);
    });
  };

  const skipBattery = () => {
    setStepStatus('battery', 'action');
    setError('Skipped — background check-in may stop when the phone sleeps.');
    goTo(stepIndex + 1);
  };

  const checkBattery = async () => {
    await runWithBusy('battery', 'Checking battery settings…', async () => {
      const snap = await getNativePermissionSnapshot();
      setManufacturer(snap.manufacturer || '');
      if (snap.batteryUnrestricted) {
        setStepStatus('battery', 'done');
        goTo(stepIndex + 1);
        return;
      }
      setStepStatus('battery', 'action');
      setError('Set battery use to Unrestricted, then return here.');
    });
  };

  const setAutoLaunch = async () => {
    await runWithBusy('autolaunch', 'Enabling start at login…', async () => {
      const api = window.scorrDesktop as
        | { setAutoLaunch?: (v: boolean) => Promise<{ ok?: boolean; enabled?: boolean }> }
        | undefined;
      if (api?.setAutoLaunch) {
        await api.setAutoLaunch(true);
      }
      setStepStatus('autolaunch', 'done');
      goTo(stepIndex + 1);
    });
  };

  const checkNetwork = async () => {
    await runWithBusy('network', 'Checking office network…', async () => {
      const match = await probeOfficeNetworkMatch();
      setNetworkMsg(
        match.matched
          ? `Matched${match.label ? `: ${match.label}` : ''} (IP ${match.ip})`
          : `No match yet (IP ${match.ip}). You can still register. Check-in later needs office Wi-Fi and a GPS reading inside the office radius.`,
      );
      setStepStatus('network', match.matched ? 'done' : 'action');
      goTo(stepIndex + 1);
    });
  };

  const register = async () => {
    await runWithBusy('register', 'Registering this device…', async () => {
      const res = await registerDeviceViaRpc('1.3.7');
      if (!res.ok) {
        setStepStatus('register', 'failed');
        setError(res.error || 'Registration failed');
        return;
      }
      if (native) {
        try {
          await startNativeAttendancePings();
        } catch {
          /* optional */
        }
      }
      if (iosHome) {
        try {
          await startIosHomeAttendance();
        } catch {
          /* optional */
        }
      }
      setStepStatus('register', 'done');
      clearSetupProgress();
      setFinished(true);
      onFinished?.();
    });
  };

  const testNow = async () => {
    setFinishMeta((m) => ({ ...m, testResult: 'Running live check…' }));
    try {
      const res = await sendAutoAttendanceEventWithLocation('ping');
      const action = (res?.action as string) || (res?.reason as string) || 'ok';
      const status =
        action === 'clock_in' || action === 'already_checked_in' || action === 'device_left_others_present'
          ? 'Checked in'
          : action === 'clock_out'
            ? 'Checked out'
            : action === 'outside_window'
              ? 'Outside shift hours'
              : action === 'not_on_office_network' || action === 'not_on_office_wifi'
                ? 'Not on office Wi-Fi'
                : action === 'outside_radius' || action === 'need_fresh_location'
                  ? 'Not inside the office radius'
                  : action === 'duplicate_ignored'
                  ? 'Check finished. Click Test now again to check in.'
                  : 'Check finished';
      setFinishMeta({
        status,
        lastCheck: new Date().toLocaleString(),
        testResult: status,
      });
    } catch (e) {
      setFinishMeta((m) => ({
        ...m,
        testResult: e instanceof Error ? e.message : String(e),
        lastCheck: new Date().toLocaleString(),
      }));
    }
  };

  const turnOff = async () => {
    setBusyText('Turning off automatic attendance…');
    setError('');
    try {
      await disableAutoAttendanceOnDevice(desktop ? 'laptop' : 'phone');
      clearSetupProgress();
      // Parent unmounts this status card and shows “Set up” again. Do not flip to
      // step UI here — that briefly replaced siblings / looked like a stuck wizard.
      if (!statusOnly) {
        setFinished(false);
        setStatuses({});
        goTo(0);
      }
      onFinished?.();
      onClose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyText('');
    }
  };

  if (finished) {
    return (
      <div className="aas-finish aas-finish--inline">
        <div className="aas-finish__card">
          <h3>Automatic attendance is ON on this {desktop ? 'laptop' : 'phone'}</h3>
          <p className="aas-finish__meta">
            Current status: {finishMeta.status}
            <br />
            Last check: {finishMeta.lastCheck}
            {finishMeta.testResult ? (
              <>
                <br />
                {finishMeta.testResult}
              </>
            ) : null}
          </p>
        </div>
        <div className="aas-finish__actions">
          <button type="button" className="btn btn-primary" onClick={() => void testNow()}>
            Test now
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (onFixProblem) {
                onFixProblem();
                return;
              }
              setFinished(false);
              goTo(0);
            }}
          >
            Fix a problem
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void turnOff()}>
            Turn off on this {desktop ? 'laptop' : 'phone'}
          </button>
        </div>
        {busyText ? (
          <p className="aas-busy-line">
            <Loader2 size={14} className="spin-icon" /> {busyText}
          </p>
        ) : null}
        {error ? <p className="aas-error">{error}</p> : null}
      </div>
    );
  }

  const progressPct = ((stepIndex + 1) / steps.length) * 100;

  return (
    <div className="aas-wizard aas-wizard--inline">
      <div className="aas-wizard__header">
        <h2 className="aas-wizard__title">Set up automatic attendance</h2>
        <p className="aas-wizard__progress-label">
          Step {stepIndex + 1} of {steps.length}
        </p>
        <div className="aas-progress" aria-hidden>
          <div className="aas-progress__bar" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {current?.id === 'disclosure' && (
        <div className="aas-disclosure">
          {iosHome ? (
            <p>
              This Home Screen app cannot run in the background. Scorr checks your location when you open it, and
              every 60 seconds while it stays open. Check-out uses the first GPS reading outside the office radius on
              those checks. You can turn this off any time in Automatic attendance settings.
            </p>
          ) : (
            <p>
              Scorr collects location data to enable automatic office check-in and check-out even when the app is closed
              or not in use. On Android, background location and an unrestricted battery setting keep that check running.
              On the iPhone app, Always location and a geofence exit do the same. Location is used from 1 hour before
              your shift starts until 1 hour after it ends. You can turn this off any time in Automatic attendance settings.
            </p>
          )}
          <p style={{ fontSize: '0.86rem' }}>{PHONE_OPT_IN_TEXT}</p>
          <div className="aas-step__actions">
            <button type="button" className="btn btn-primary" onClick={continueDisclosure}>
              Continue
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Not now
            </button>
          </div>
        </div>
      )}

      <ul className="aas-checklist">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const st = statuses[s.id] || (i < stepIndex ? 'done' : i === stepIndex ? 'waiting' : 'waiting');
          const active = i === stepIndex && current?.id !== 'disclosure';
          if (s.id === 'disclosure' && current?.id === 'disclosure') return null;
          if (s.id === 'disclosure') return null;
          if (s.id === 'battery' && !isAndroidApp()) return null;
          return (
            <li key={s.id} className={`aas-step ${active ? 'aas-step--active' : ''} ${st === 'done' ? 'aas-step--done' : ''}`}>
              <div className="aas-step__icon">
                {st === 'done' ? <CheckCircle2 size={18} /> : st === 'failed' ? <XCircle size={18} /> : <Icon size={18} />}
              </div>
              <div className="aas-step__body">
                <div className="aas-step__title-row">
                  <h3 className="aas-step__title">{s.title}</h3>
                  <span className={statusClass(st)}>{statusLabel(st)}</span>
                </div>
                <p className="aas-step__expl">{s.explanation}</p>
                {active && busyText && (
                  <span className="aas-busy-line">
                    <Loader2 size={14} className="spin-icon" /> {busyText}
                  </span>
                )}
                {active && error && <p className="aas-error">{error}</p>}
                {active && setup && s.id === 'account' && setup.issues.length > 0 && (
                  <ul className="aas-tips">
                    {setup.issues.map((iss) => (
                      <li key={iss}>{iss}</li>
                    ))}
                  </ul>
                )}
                {active && s.id === 'battery' && (
                  <ul className="aas-tips">
                    {batteryTips(manufacturer).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                )}
                {active && s.id === 'network' && networkMsg && <p className="aas-step__expl">{networkMsg}</p>}
                {active && (
                  <div className="aas-step__actions">
                    {s.id === 'account' && (
                      <button type="button" className="btn btn-primary" onClick={() => void checkAccount()}>
                        {st === 'failed' ? 'Try again' : 'Check account'}
                      </button>
                    )}
                    {s.id === 'account' && setup && !setup.ok && setup.is_admin && (
                      <a className="btn btn-secondary" href="#office-attendance">
                        Fix it
                      </a>
                    )}
                    {s.id === 'location' && (
                      <>
                        <button type="button" className="btn btn-primary" onClick={() => void requestLocation()}>
                          {st === 'failed' || st === 'action' ? 'Try again' : 'Allow location'}
                        </button>
                        {!iosHome && (
                          <button type="button" className="btn btn-secondary" onClick={() => void openNativeAppSettings()}>
                            Open settings
                          </button>
                        )}
                        <button type="button" className="btn btn-secondary" onClick={() => void refreshPermissions()}>
                          <RefreshCw size={14} /> I changed settings
                        </button>
                      </>
                    )}
                    {s.id === 'notifications' && (
                      <>
                        <button type="button" className="btn btn-primary" onClick={() => void requestNotifs()}>
                          {st === 'failed' ? 'Try again' : 'Allow notifications'}
                        </button>
                        {!iosHome && (
                          <button type="button" className="btn btn-secondary" onClick={() => void openNativeAppSettings()}>
                            Open settings
                          </button>
                        )}
                      </>
                    )}
                    {s.id === 'battery' && isAndroidApp() && (
                      <>
                        <button type="button" className="btn btn-primary" onClick={() => void checkBattery()}>
                          Check battery
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => void openNativeBatterySettings()}>
                          Open settings
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={skipBattery}>
                          Skip for now
                        </button>
                      </>
                    )}
                    {s.id === 'autolaunch' && (
                      <button type="button" className="btn btn-primary" onClick={() => void setAutoLaunch()}>
                        Enable auto-start
                      </button>
                    )}
                    {s.id === 'network' && (
                      <button type="button" className="btn btn-primary" onClick={() => void checkNetwork()}>
                        {st === 'failed' ? 'Try again' : 'Check network'}
                      </button>
                    )}
                    {s.id === 'register' && (
                      <button type="button" className="btn btn-primary" onClick={() => void register()}>
                        {st === 'failed' ? 'Try again' : desktop ? 'Register this laptop' : 'Register this phone'}
                      </button>
                    )}
                  </div>
                )}
                {!active && i === stepIndex && st === 'waiting' && s.id !== 'disclosure' && (
                  <div className="aas-step__actions">
                    <button type="button" className="btn btn-secondary" onClick={() => goTo(i)}>
                      <Circle size={12} /> Continue here
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {error && current?.id !== 'account' && current?.id !== 'location' && (
        <p className="aas-error">
          <AlertTriangle size={14} /> {error}
        </p>
      )}

      {onClose && current?.id !== 'disclosure' && (
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  );
}
