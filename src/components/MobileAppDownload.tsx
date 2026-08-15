import { useEffect, useState } from 'react';
import {
  Smartphone,
  Download,
  Apple,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Package,
  Calendar,
  Shield,
  Home,
  FileText,
} from 'lucide-react';

const APK_PATH = '/downloads/scorr.apk';
const BUILD_INFO_PATH = '/downloads/build-info.json';
const IPA_PATH = '/downloads/scorr.ipa';
const USER_GUIDE_PATH = '/downloads/Scorr-Client-Feature-Guide.pdf';
const TESTFLIGHT_URL = import.meta.env.VITE_TESTFLIGHT_URL as string | undefined;

interface PlatformBuildInfo {
  available?: boolean;
  filename?: string;
  ipaFilename?: string;
  appName?: string;
  appId?: string;
  version?: string;
  buildType?: string;
  installMethod?: 'pwa' | 'ipa' | 'testflight';
  sizeBytes?: number;
  sizeLabel?: string;
  updatedAt?: string;
  updatedLabel?: string;
  pwaUrl?: string;
  ipaAvailable?: boolean;
}

interface BuildInfoFile {
  android?: PlatformBuildInfo;
  ios?: PlatformBuildInfo;
}

function assetUrl(path: string): string {
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}

const DEFAULT_PWA_URL = 'https://scorr.walfia.ai/?app=1';

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

async function fetchBuildInfo(): Promise<BuildInfoFile | null> {
  try {
    const r = await fetch(assetUrl(BUILD_INFO_PATH), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
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
    const length = Number(r.headers.get('content-length') || 0);
    if (!r.ok || type.includes('text/html')) return false;
    if (types.some((t) => type.includes(t))) return true;
    return length > 1_000_000;
  } catch {
    return false;
  }
}

const APP_FEATURES = [
  'Admin, manager & employee dashboards',
  'Hamburger navigation on mobile',
  'GPS attendance & live tracking',
  'KPI tasks, rewards & reports',
];

export default function MobileAppDownload() {
  const [buildInfo, setBuildInfo] = useState<BuildInfoFile | null>(null);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [ipaReady, setIpaReady] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  const androidInfo = buildInfo?.android;
  const iosInfo = buildInfo?.ios;
  const pwaUrl = iosInfo?.pwaUrl || DEFAULT_PWA_URL;
  const pwaHost = pwaUrl.replace(/^https?:\/\//, '');

  useEffect(() => {
    setInstalled(isStandalonePwa());

    void (async () => {
      const info = await fetchBuildInfo();
      setBuildInfo(info);
      const headOk = await checkApkAvailable();
      setApkReady(headOk || info?.android?.available === true);
      const ipaHead = await checkBinary(IPA_PATH, ['octet-stream', 'zip', 'ipa', 'application']);
      setIpaReady(ipaHead || info?.ios?.ipaAvailable === true);
    })();
  }, []);

  const downloadApk = () => {
    window.location.href = assetUrl(APK_PATH);
  };

  const downloadIpa = () => {
    window.location.href = assetUrl(IPA_PATH);
  };

  const openPwaInstall = () => {
    setIosHint(true);
    if (isIos() && !isStandalonePwa()) {
      window.scrollTo({ top: document.getElementById('download-app')?.offsetTop ?? 0, behavior: 'smooth' });
      return;
    }
    window.open(pwaUrl, '_blank', 'noopener,noreferrer');
  };

  const iosReady = iosInfo?.available !== false;

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Mobile App</div>
        <h2 className="landing-section__title">Download Scorr for Android &amp; iOS</h2>
        <p>
          Android installs via APK. iPhone &amp; iPad install from Safari in one tap — same login, KPIs,
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

          {androidInfo && apkReady && (
            <div className="landing-download-meta">
              <span><Package size={14} /> v{androidInfo.version} · {androidInfo.sizeLabel}</span>
              <span><Calendar size={14} /> Updated {androidInfo.updatedLabel}</span>
              <span><Shield size={14} /> {androidInfo.appId}</span>
            </div>
          )}

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
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
                {androidInfo?.sizeLabel ? ` (${androidInfo.sizeLabel})` : ''}
              </button>
              <a
                href={assetUrl(APK_PATH)}
                className="landing-download-direct"
                download="scorr.apk"
              >
                Direct link · {pwaHost}/downloads/scorr.apk
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
            {iosReady && (
              <span className="landing-download-badge landing-download-badge--live">iOS app ready</span>
            )}
          </div>

          <h3>iPhone &amp; iPad app</h3>
          <p>
            Install from <strong>Safari</strong> → <strong>Add to Home Screen</strong>. The iOS app opens to
            <strong> Sign In / Register Company</strong> only — not the full marketing website — same as Android.
          </p>

          {iosInfo && iosReady && (
            <div className="landing-download-meta">
              <span><Package size={14} /> v{iosInfo.version} · Home Screen app</span>
              <span><Calendar size={14} /> Updated {iosInfo.updatedLabel}</span>
              <span><Shield size={14} /> {iosInfo.appId}</span>
            </div>
          )}

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          <ol className="landing-download-steps">
            <li>Open <strong>{pwaHost}</strong> in <strong>Safari</strong> on your iPhone</li>
            <li>Tap <strong>Share</strong> (square with arrow up)</li>
            <li>Scroll → <strong>Add to Home Screen</strong> → <strong>Add</strong></li>
            <li>Open the Scorr icon — you see Sign In / Register only</li>
            <li>Sign in and allow <strong>Location</strong> for auto attendance</li>
          </ol>

          {installed ? (
            <div className="landing-download-installed">
              <CheckCircle size={18} /> Scorr is installed on this device
            </div>
          ) : isIos() ? (
            <button type="button" className="btn btn-primary landing-download-btn" onClick={openPwaInstall}>
              <Home size={18} /> Install Scorr on this iPhone
            </button>
          ) : (
            <button type="button" className="btn btn-primary landing-download-btn" onClick={openPwaInstall}>
              <Apple size={18} /> Open iOS install page
            </button>
          )}

          <a href={pwaUrl} className="landing-download-direct">
            Install URL · {pwaHost}
          </a>

          {iosHint && isIos() && !installed && (
            <p className="landing-download-note landing-download-note--highlight">
              Tap <strong>Share</strong> at the bottom of Safari → <strong>Add to Home Screen</strong>
            </p>
          )}

          {isIos() && !installed && iosReady && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on iPhone — use Share → Add to Home Screen to install Scorr.
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
            <>
              <button type="button" className="btn btn-secondary landing-download-btn" onClick={downloadIpa}>
                <Download size={18} /> Download developer IPA
                {iosInfo?.sizeLabel ? ` (${iosInfo.sizeLabel})` : ''}
              </button>
              <p className="landing-download-footnote">
                IPA files require registered devices or TestFlight — for IT teams and Xcode installs.
              </p>
            </>
          )}

          {!TESTFLIGHT_URL && !ipaReady && (
            <p className="landing-download-footnote">
              Native App Store / TestFlight builds require an Apple Developer account on macOS.
              Home Screen install works for all iPhone users today.
            </p>
          )}
        </div>
      </div>

      <div className="landing-guide-strip landing-reveal">
        <div className="landing-guide-strip__icon">
          <FileText size={22} />
        </div>
        <div className="landing-guide-strip__copy">
          <h3>Scorr user guide (PDF)</h3>
          <p>
            Step-by-step: register your organization, understand Admin / Manager / Employee roles,
            and add new users.
          </p>
        </div>
        <a
          className="btn btn-secondary landing-download-btn"
          href={USER_GUIDE_PATH}
          download="Scorr-Client-Feature-Guide.pdf"
          target="_blank"
          rel="noreferrer"
        >
          <Download size={16} /> Download PDF guide
        </a>
      </div>
    </section>
  );
}
