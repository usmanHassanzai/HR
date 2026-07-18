import { useEffect, useState } from 'react';
import {
  Smartphone,
  Download,
  Apple,
  Share,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Package,
  Calendar,
  Shield,
} from 'lucide-react';

const APK_PATH = '/downloads/scorr.apk';
const BUILD_INFO_PATH = '/downloads/build-info.json';
const IPA_PATH = '/downloads/scorr.ipa';
const TESTFLIGHT_URL = import.meta.env.VITE_TESTFLIGHT_URL as string | undefined;

interface AndroidBuildInfo {
  available?: boolean;
  filename?: string;
  appName?: string;
  appId?: string;
  version?: string;
  buildType?: string;
  sizeBytes?: number;
  sizeLabel?: string;
  updatedAt?: string;
  updatedLabel?: string;
}

function assetUrl(path: string): string {
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}

const APP_URL = typeof window !== 'undefined' ? window.location.origin : 'https://scorr.walfia.ai';

function isStandalonePwa(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

async function fetchBuildInfo(): Promise<AndroidBuildInfo | null> {
  try {
    const r = await fetch(assetUrl(BUILD_INFO_PATH), { cache: 'no-store' });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.android ?? null;
  } catch {
    return null;
  }
}

async function checkApkAvailable(): Promise<boolean> {
  try {
    const r = await fetch(assetUrl(APK_PATH), { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return false;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const length = Number(r.headers.get('content-length') || 0);
    if (type.includes('text/html')) return false;
    if (
      type.includes('android')
      || type.includes('octet-stream')
      || type.includes('zip')
      || type.includes('application/vnd.android')
    ) {
      return true;
    }
    return length > 5_000_000;
  } catch {
    return false;
  }
}

async function checkBinary(path: string, types: string[]): Promise<boolean> {
  try {
    const r = await fetch(assetUrl(path), { method: 'HEAD', cache: 'no-store' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html') && types.some((t) => type.includes(t));
  } catch {
    return false;
  }
}

const ANDROID_FEATURES = [
  'Admin, manager & employee dashboards',
  'Hamburger navigation on mobile',
  'GPS attendance & live tracking',
  'KPI tasks, rewards & reports',
];

export default function MobileAppDownload() {
  const [buildInfo, setBuildInfo] = useState<AndroidBuildInfo | null>(null);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [ipaReady, setIpaReady] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    setInstalled(isStandalonePwa());

    void (async () => {
      const info = await fetchBuildInfo();
      setBuildInfo(info);
      const headOk = await checkApkAvailable();
      setApkReady(headOk || info?.available === true);
    })();

    void checkBinary(IPA_PATH, ['octet-stream', 'zip', 'ipa']).then(setIpaReady);
  }, []);

  const downloadApk = () => {
    window.location.href = assetUrl(APK_PATH);
  };

  const showIosInstall = () => {
    setIosHint(true);
    if (isIos() && !isStandalonePwa()) {
      window.scrollTo({ top: document.getElementById('download-app')?.offsetTop ?? 0, behavior: 'smooth' });
    }
  };

  const openSafariInstall = () => {
    if (isIos()) {
      showIosInstall();
      return;
    }
    window.open(APP_URL, '_blank', 'noopener,noreferrer');
  };

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Mobile App</div>
        <h2 className="landing-section__title">Download Scorr for Android &amp; iOS</h2>
        <p>
          Install the native Android app or add Scorr to your iPhone home screen — same login, KPIs,
          hamburger dashboards, GPS attendance, and rewards on the go.
        </p>
      </div>

      <div className="landing-download-grid landing-reveal">
        <div className="landing-download-card landing-download-card--android">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--android">
              <Smartphone size={28} />
            </div>
            {apkReady && (
              <span className="landing-download-badge landing-download-badge--live">Latest build ready</span>
            )}
          </div>

          <h3>Android app (.apk)</h3>
          <p>
            Installs <strong>Scorr</strong> as a real Android app — opens directly to sign-in with the
            updated mobile layout for admin, manager, and employee roles.
          </p>

          {buildInfo && apkReady && (
            <div className="landing-download-meta">
              <span><Package size={14} /> v{buildInfo.version} · {buildInfo.sizeLabel}</span>
              <span><Calendar size={14} /> Updated {buildInfo.updatedLabel}</span>
              <span><Shield size={14} /> {buildInfo.appId}</span>
            </div>
          )}

          <ul className="landing-download-features">
            {ANDROID_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          <ol className="landing-download-steps">
            <li>Tap <strong>Download Android APK</strong> below</li>
            <li>Open your <strong>Downloads</strong> folder and tap <strong>scorr.apk</strong></li>
            <li>Allow install from your browser if Android asks</li>
            <li>Open Scorr → sign in → allow <strong>Location</strong> for attendance</li>
          </ol>

          {apkReady === null ? (
            <button type="button" className="btn btn-secondary landing-download-btn" disabled>
              <Loader2 size={16} className="spin-icon" /> Checking download…
            </button>
          ) : apkReady ? (
            <>
              <button type="button" className="btn btn-primary landing-download-btn" onClick={downloadApk}>
                <Download size={18} /> Download Android APK
                {buildInfo?.sizeLabel ? ` (${buildInfo.sizeLabel})` : ''}
              </button>
              <a
                href={assetUrl(APK_PATH)}
                className="landing-download-direct"
                download="scorr.apk"
              >
                Direct link · scorr.walfia.ai/downloads/scorr.apk
              </a>
            </>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>APK is being prepared — use the web app or check back after the next deploy.</span>
            </div>
          )}

          {isAndroid() && apkReady && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on Android — tap the button above to install the latest Scorr app.
            </p>
          )}
        </div>

        <div className="landing-download-card landing-download-card--ios">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--ios">
              <Apple size={28} />
            </div>
            <span className="landing-download-badge landing-download-badge--pwa">Safari · Home Screen</span>
          </div>

          <h3>iPhone &amp; iPad app</h3>
          <p>
            Same native-style experience as Android — sign-in, dashboards, GPS attendance, and rewards.
            Install in <strong>one tap</strong> from Safari (no App Store required).
          </p>

          <ol className="landing-download-steps">
            <li>Open <strong>{APP_URL.replace('https://', '')}</strong> in <strong>Safari</strong></li>
            <li>Tap <strong>Share</strong> (square with arrow up)</li>
            <li>Scroll → <strong>Add to Home Screen</strong></li>
            <li>Tap <strong>Add</strong> — open Scorr from your home screen</li>
            <li>Sign in and allow <strong>Location</strong> for auto attendance</li>
          </ol>

          {installed ? (
            <div className="landing-download-installed">
              <CheckCircle size={18} /> Scorr is installed on this device
            </div>
          ) : isIos() ? (
            <button type="button" className="btn btn-primary landing-download-btn" onClick={showIosInstall}>
              <Share size={18} /> Install Scorr on this iPhone
            </button>
          ) : (
            <button type="button" className="btn btn-primary landing-download-btn" onClick={openSafariInstall}>
              <Apple size={18} /> Get iOS install instructions
            </button>
          )}

          {iosHint && isIos() && !installed && (
            <p className="landing-download-note landing-download-note--highlight">
              Tap <strong>Share</strong> at the bottom of Safari → <strong>Add to Home Screen</strong>
            </p>
          )}

          {TESTFLIGHT_URL && (
            <a
              href={TESTFLIGHT_URL}
              className="btn btn-secondary landing-download-btn"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} /> Install via TestFlight
            </a>
          )}

          {ipaReady && (
            <p className="landing-download-footnote">
              Developer IPA available — use TestFlight or Xcode for device install (iOS does not allow direct APK-style downloads).
            </p>
          )}

          {!TESTFLIGHT_URL && !ipaReady && (
            <p className="landing-download-footnote">
              For a native App Store build, use TestFlight or Xcode on macOS.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
