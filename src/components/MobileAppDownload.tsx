import { useEffect, useState } from 'react';
import {
  Smartphone,
  Download,
  Apple,
  CheckCircle,
  AlertCircle,
  Loader2,
  Package,
  Calendar,
  Shield,
  FileText,
} from 'lucide-react';
import {
  APK_DIRECT_UNTIL,
  APK_PATH,
  APP_STORE_URL,
  PLAY_STORE_URL,
  isApkDirectDownloadAvailable,
  showStoreInstallCtas,
} from '../utils/appStoreLinks';

const BUILD_INFO_PATH = '/downloads/build-info.json';
const USER_GUIDE_PATH = '/downloads/Scorr-Client-Feature-Guide.pdf';

interface PlatformBuildInfo {
  available?: boolean;
  filename?: string;
  appName?: string;
  appId?: string;
  version?: string;
  sizeBytes?: number;
  sizeLabel?: string;
  updatedAt?: string;
  updatedLabel?: string;
}

interface BuildInfoFile {
  android?: PlatformBuildInfo;
  ios?: PlatformBuildInfo;
}

function assetUrl(path: string): string {
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}

function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
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

const APP_FEATURES = [
  'Admin, manager & employee dashboards',
  'Hamburger navigation on mobile',
  'GPS attendance & live tracking',
  'KPI tasks, rewards & reports',
];

const apkUntilLabel = APK_DIRECT_UNTIL.toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export default function MobileAppDownload() {
  const [buildInfo, setBuildInfo] = useState<BuildInfoFile | null>(null);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [onAndroid, setOnAndroid] = useState(false);
  const apkWindowOpen = isApkDirectDownloadAvailable();

  const androidInfo = buildInfo?.android;

  useEffect(() => {
    if (!showStoreInstallCtas()) return;
    setOnAndroid(isAndroid());
    void (async () => {
      const info = await fetchBuildInfo();
      setBuildInfo(info);
      if (!apkWindowOpen) {
        setApkReady(false);
        return;
      }
      const headOk = await checkApkAvailable();
      setApkReady(headOk || info?.android?.available === true);
    })();
  }, [apkWindowOpen]);

  if (!showStoreInstallCtas()) return null;

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Mobile App</div>
        <h2 className="landing-section__title">Get Scorr on Android &amp; iPhone</h2>
        <p>
          Install from Google Play or the App Store — same secure login, KPIs, GPS attendance,
          and rewards as the web app.
        </p>
      </div>

      <div className="landing-download-grid landing-reveal">
        <div className="landing-download-card landing-download-card--android">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--android">
              <Smartphone size={28} />
            </div>
            <span className="landing-download-badge landing-download-badge--live">Google Play</span>
          </div>

          <h3>Android app</h3>
          <p>
            Install <strong>Scorr</strong> from Google Play for automatic updates and the full
            native experience.
          </p>

          {androidInfo && (
            <div className="landing-download-meta">
              <span><Package size={14} /> v{androidInfo.version}{androidInfo.sizeLabel ? ` · ${androidInfo.sizeLabel}` : ''}</span>
              {androidInfo.updatedLabel && (
                <span><Calendar size={14} /> Updated {androidInfo.updatedLabel}</span>
              )}
              <span><Shield size={14} /> {androidInfo.appId || 'ai.walfia.scorr'}</span>
            </div>
          )}

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          <a
            href={PLAY_STORE_URL}
            className="btn btn-primary landing-download-btn"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Download size={18} /> Download Android App
          </a>
          <a
            href={PLAY_STORE_URL}
            className="landing-download-direct"
            target="_blank"
            rel="noopener noreferrer"
          >
            play.google.com/store/apps/details?id=ai.walfia.scorr
          </a>

          {onAndroid && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on Android — open Google Play to install or update Scorr.
            </p>
          )}

          {apkWindowOpen && (
            <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
              <p className="landing-download-footnote" style={{ marginBottom: '0.65rem' }}>
                Direct APK sideload remains available until <strong>{apkUntilLabel}</strong>, then it will be removed.
              </p>
              {apkReady === null ? (
                <button type="button" className="btn btn-secondary landing-download-btn" disabled>
                  <Loader2 size={16} className="spin-icon" /> Checking APK…
                </button>
              ) : apkReady ? (
                <a href={assetUrl(APK_PATH)} className="btn btn-secondary landing-download-btn" download="scorr.apk">
                  <Download size={18} /> Download APK (legacy)
                  {androidInfo?.sizeLabel ? ` · ${androidInfo.sizeLabel}` : ''}
                </a>
              ) : (
                <div className="landing-download-soon">
                  <AlertCircle size={16} />
                  <span>APK not available right now — use Google Play instead.</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="landing-download-card landing-download-card--ios">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--ios">
              <Apple size={28} />
            </div>
            <span className="landing-download-badge landing-download-badge--live">App Store</span>
          </div>

          <h3>iPhone &amp; iPad app</h3>
          <p>
            Install <strong>Scorr</strong> from the App Store for the native iOS experience —
            Sign In, MFA, KPIs, and GPS attendance.
          </p>

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          {APP_STORE_URL ? (
            <>
              <a
                href={APP_STORE_URL}
                className="btn btn-primary landing-download-btn"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Apple size={18} /> Install on iPhone
              </a>
              <a
                href={APP_STORE_URL}
                className="landing-download-direct"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in the App Store
              </a>
            </>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>
                App Store link not configured yet. Set <code>VITE_APP_STORE_URL</code> to your listing URL.
              </span>
            </div>
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
            Roles, KPIs, weightage rewards (Current / Used / Banked), attendance, mobile apps,
            and MFA — Scorr-only, step by step.
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
