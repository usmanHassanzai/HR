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
  Home,
  Monitor,
} from 'lucide-react';
import {
  APK_DIRECT_UNTIL,
  APK_PATH,
  APP_STORE_URL,
  DESKTOP_LINUX_DEB_PATH,
  DESKTOP_WIN_PATH,
  IOS_PWA_INSTALL_URL,
  PLAY_STORE_LIVE,
  PLAY_STORE_URL,
  androidInstallHref,
  androidInstallIsDownload,
  isApkDirectDownloadAvailable,
  iosInstallHref,
  iosInstallIsAppStore,
  showStoreInstallCtas,
} from '../utils/appStoreLinks';

const BUILD_INFO_PATH = '/downloads/build-info.json';
const USER_GUIDE_PATH = '/downloads/Scorr-Client-Feature-Guide.pdf';
const SECURITY_GUIDE_PATH = '/downloads/Scorr-Security-Overview.pdf';

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
  pwaUrl?: string;
}

interface DesktopPlatformInfo {
  available?: boolean;
  filename?: string;
  sizeBytes?: number;
  sizeLabel?: string;
  url?: string;
}

interface DesktopBuildInfo {
  available?: boolean;
  appName?: string;
  appId?: string;
  version?: string;
  updatedAt?: string;
  updatedLabel?: string;
  platforms?: {
    windows?: DesktopPlatformInfo;
    linuxDeb?: DesktopPlatformInfo;
  };
}

interface BuildInfoFile {
  android?: PlatformBuildInfo;
  ios?: PlatformBuildInfo;
  desktop?: DesktopBuildInfo;
}

function isWindowsUa(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Windows/i.test(navigator.userAgent);
}

function isLinuxUa(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Linux/i.test(ua) && !/Android/i.test(ua);
}

function assetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}

function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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

async function checkDesktopFile(path: string): Promise<boolean> {
  // Cross-origin hosts (GitHub Releases) often block browser HEAD — treat absolute http(s) as OK.
  if (/^https?:\/\//i.test(path)) return true;
  try {
    const r = await fetch(assetUrl(path), { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return false;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) return false;
    const length = Number(r.headers.get('content-length') || 0);
    return length > 1_000_000 || type.includes('octet-stream') || type.includes('appimage');
  } catch {
    return false;
  }
}

export default function MobileAppDownload() {
  const [buildInfo, setBuildInfo] = useState<BuildInfoFile | null>(null);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [desktopReady, setDesktopReady] = useState<{
    win: boolean;
    deb: boolean;
  } | null>(null);
  const [ua, setUa] = useState<{ ios: boolean; android: boolean; win: boolean; linux: boolean } | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);
  const apkWindowOpen = isApkDirectDownloadAvailable();

  const androidInfo = buildInfo?.android;
  const iosInfo = buildInfo?.ios;
  const desktopInfo = buildInfo?.desktop;
  const pwaUrl = iosInfo?.pwaUrl || IOS_PWA_INSTALL_URL;
  const pwaHost = pwaUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
  const onIos = ua?.ios === true;
  const onAndroid = ua?.android === true;
  const onWindows = ua?.win === true;
  const onLinux = ua?.linux === true;
  const androidHref = androidInstallHref();
  const androidIsFile = androidInstallIsDownload();

  const winHref =
    desktopInfo?.platforms?.windows?.url
    || DESKTOP_WIN_PATH;
  const linuxDebHref =
    desktopInfo?.platforms?.linuxDeb?.url
    || DESKTOP_LINUX_DEB_PATH;

  const winReady = desktopReady?.win === true;
  const linuxReady = desktopReady?.deb === true;

  useEffect(() => {
    if (!showStoreInstallCtas()) return;
    setUa({
      ios: isIos(),
      android: isAndroid(),
      win: isWindowsUa(),
      linux: isLinuxUa(),
    });
    setInstalled(isStandalonePwa());
    void (async () => {
      const info = await fetchBuildInfo();
      setBuildInfo(info);
      if (!apkWindowOpen) {
        setApkReady(false);
      } else {
        const headOk = await checkApkAvailable();
        setApkReady(headOk || info?.android?.available === true);
      }

      const winUrl = info?.desktop?.platforms?.windows?.url || DESKTOP_WIN_PATH;
      const debUrl = info?.desktop?.platforms?.linuxDeb?.url || DESKTOP_LINUX_DEB_PATH;

      const [winOk, debOk] = await Promise.all([
        checkDesktopFile(winUrl),
        checkDesktopFile(debUrl),
      ]);
      setDesktopReady({
        win: winOk && (info?.desktop?.platforms?.windows?.available !== false),
        deb: debOk && (info?.desktop?.platforms?.linuxDeb?.available !== false),
      });
    })();
  }, [apkWindowOpen]);

  const openPwaInstall = () => {
    setIosHint(true);
    if (isIos() && !isStandalonePwa()) {
      window.scrollTo({ top: document.getElementById('download-app')?.offsetTop ?? 0, behavior: 'smooth' });
      return;
    }
    window.open(pwaUrl, '_blank', 'noopener,noreferrer');
  };

  if (!showStoreInstallCtas()) return null;

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Apps</div>
        <h2 className="landing-section__title">Download Scorr for Windows, Linux, Android &amp; iOS</h2>
        <p>
          Separate installers for each platform — same Sign In for admin, HR, managers, and employees.
          Windows Setup, Linux .deb, Android APK{PLAY_STORE_LIVE ? ' / Google Play' : ''}, and iPhone
          {iosInstallIsAppStore() ? ' (App Store)' : ' (Home Screen)'}.
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
              <span><Shield size={14} /> {androidInfo.appId || 'ai.walfia.scorr'}</span>
            </div>
          )}

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          <ol className="landing-download-steps">
            <li>Tap <strong>Download Android App</strong> below</li>
            <li>Open your <strong>Downloads</strong> folder and tap <strong>scorr.apk</strong></li>
            <li>Allow install from your browser if Android asks</li>
            <li>Open Scorr → sign in → allow <strong>Location</strong> for attendance</li>
          </ol>

          {PLAY_STORE_LIVE ? (
            <a
              href={PLAY_STORE_URL}
              className="btn btn-primary landing-download-btn"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download size={18} /> Get it on Google Play
            </a>
          ) : null}

          {apkWindowOpen && (
            apkReady === null ? (
              <button type="button" className="btn btn-secondary landing-download-btn" disabled>
                <Loader2 size={16} className="spin-icon" /> Checking download…
              </button>
            ) : apkReady ? (
              <>
                <a
                  href={androidIsFile ? assetUrl(APK_PATH) : androidHref}
                  className="btn btn-primary landing-download-btn"
                  download={androidIsFile ? 'scorr.apk' : undefined}
                  {...(!androidIsFile ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <Download size={18} /> Download Android App
                  {androidInfo?.sizeLabel ? ` (${androidInfo.sizeLabel})` : ''}
                </a>
                <a
                  href={assetUrl(APK_PATH)}
                  className="landing-download-direct"
                  download="scorr.apk"
                >
                  Direct link · {typeof window !== 'undefined' ? window.location.host : 'scorr.walfia.ai'}
                  /downloads/scorr.apk
                </a>
                <p className="landing-download-footnote">
                  Direct APK available until <strong>{apkUntilLabel}</strong>
                  {PLAY_STORE_LIVE ? '' : ' (Google Play listing not live yet)'}.
                </p>
              </>
            ) : (
              <div className="landing-download-soon">
                <AlertCircle size={16} />
                <span>APK is being prepared — check back after the next deploy.</span>
              </div>
            )
          )}

          {onAndroid && apkReady && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on Android — tap the button above to download and install Scorr.
            </p>
          )}
        </div>

        <div className="landing-download-card landing-download-card--ios">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--ios">
              <Apple size={28} />
            </div>
            <span className="landing-download-badge landing-download-badge--live">
              {iosInstallIsAppStore() ? 'App Store' : 'iOS ready'}
            </span>
          </div>

          <h3>iPhone &amp; iPad app</h3>
          {iosInstallIsAppStore() ? (
            <p>
              Install <strong>Scorr</strong> from the App Store for the native iPhone experience —
              Sign In, MFA (trusted devices), KPIs, and automatic attendance (Always location + office Wi-Fi), same as Android.
            </p>
          ) : (
            <p>
              Install from <strong>Safari</strong> → <strong>Add to Home Screen</strong> for Sign In, MFA, KPIs, and GPS attendance.
              The native Capacitor iPhone build (when published) adds Always location, region monitoring, and automatic attendance setup — same path as Android.
            </p>
          )}

          <ul className="landing-download-features">
            {APP_FEATURES.map((item) => (
              <li key={item}><CheckCircle size={14} /> {item}</li>
            ))}
          </ul>

          {iosInstallIsAppStore() ? (
            <>
              <a
                href={iosInstallHref()}
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
            <>
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
              ) : onIos ? (
                <a
                  href={pwaUrl}
                  className="btn btn-primary landing-download-btn"
                  onClick={(e) => { e.preventDefault(); openPwaInstall(); }}
                >
                  <Home size={18} /> Install Scorr on this iPhone
                </a>
              ) : (
                <a
                  href={pwaUrl}
                  className="btn btn-primary landing-download-btn"
                  onClick={(e) => { e.preventDefault(); openPwaInstall(); }}
                >
                  <Apple size={18} /> Open iOS install page
                </a>
              )}

              <a href={pwaUrl} className="landing-download-direct">
                Install URL · {pwaHost}
              </a>

              {iosHint && onIos && !installed && (
                <p className="landing-download-note landing-download-note--highlight">
                  Tap <strong>Share</strong> at the bottom of Safari → <strong>Add to Home Screen</strong>
                </p>
              )}

              {onIos && !installed && (
                <p className="landing-download-note landing-download-note--highlight">
                  You&apos;re on iPhone — use Share → Add to Home Screen to install Scorr.
                </p>
              )}

              <p className="landing-download-footnote">
                Native App Store listing is not live yet — Home Screen install works for all iPhone users today.
              </p>
            </>
          )}
        </div>

        <div id="download-windows" className="landing-download-card landing-download-card--windows">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--windows">
              <Monitor size={28} />
            </div>
            {winReady && (
              <span className="landing-download-badge landing-download-badge--live">Windows ready</span>
            )}
          </div>

          <h3>Windows desktop</h3>
          <p>
            Install <strong>Scorr</strong> permanently on Windows PCs — Setup adds Start Menu and
            Desktop shortcuts. Opens to the same Sign In / Register screen for every role.
          </p>

          {desktopInfo?.platforms?.windows && (
            <div className="landing-download-meta">
              <span><Package size={14} /> v{desktopInfo.version} · {desktopInfo.platforms.windows.sizeLabel}</span>
              {desktopInfo.updatedLabel && (
                <span><Calendar size={14} /> Updated {desktopInfo.updatedLabel}</span>
              )}
              <span><Shield size={14} /> {desktopInfo.appId || 'ai.walfia.scorr.desktop'}</span>
            </div>
          )}

          <ul className="landing-download-features">
            <li><CheckCircle size={14} /> Real installer (Start Menu + Desktop)</li>
            <li><CheckCircle size={14} /> Same Sign In as web &amp; mobile</li>
            <li><CheckCircle size={14} /> One app for every role</li>
          </ul>

          <ol className="landing-download-steps">
            <li>Click <strong>Download for Windows</strong></li>
            <li>Run <strong>Scorr-Setup.exe</strong></li>
            <li>Follow the installer → open Scorr from Start Menu</li>
          </ol>

          {desktopReady === null ? (
            <button type="button" className="btn btn-secondary landing-download-btn" disabled>
              <Loader2 size={16} className="spin-icon" /> Checking download…
            </button>
          ) : winReady ? (
            <>
              <a
                href={assetUrl(winHref)}
                className="btn btn-primary landing-download-btn"
                {...(/^https?:\/\//i.test(winHref)
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { download: 'Scorr-Setup.exe' })}
              >
                <Download size={18} /> Download for Windows
                {desktopInfo?.platforms?.windows?.sizeLabel
                  ? ` (${desktopInfo.platforms.windows.sizeLabel})`
                  : ''}
              </a>
              <a
                href={assetUrl(winHref)}
                className="landing-download-direct"
                {...(/^https?:\/\//i.test(winHref)
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { download: 'Scorr-Setup.exe' })}
              >
                Direct link · {/^https?:\/\//i.test(winHref) ? 'GitHub Release' : '/downloads/Scorr-Setup.exe'}
              </a>
            </>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>Windows installer is being prepared — check back after the next deploy.</span>
            </div>
          )}

          {onWindows && winReady && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on Windows — run <strong>Scorr-Setup.exe</strong> to install permanently.
            </p>
          )}
        </div>

        <div id="download-linux" className="landing-download-card landing-download-card--linux">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--linux">
              <Monitor size={28} />
            </div>
            {linuxReady && (
              <span className="landing-download-badge landing-download-badge--live">Linux ready</span>
            )}
          </div>

          <h3>Linux desktop</h3>
          <p>
            Install <strong>Scorr</strong> with the .deb package on Ubuntu/Debian — same Sign In
            screen as Windows and mobile for admin, HR, manager, and employee.
          </p>

          {desktopInfo?.platforms?.linuxDeb && (
            <div className="landing-download-meta">
              <span>
                <Package size={14} /> v{desktopInfo.version}
                {desktopInfo.platforms.linuxDeb.sizeLabel
                  ? ` · ${desktopInfo.platforms.linuxDeb.sizeLabel}`
                  : ''}
              </span>
              {desktopInfo.updatedLabel && (
                <span><Calendar size={14} /> Updated {desktopInfo.updatedLabel}</span>
              )}
              <span><Shield size={14} /> {desktopInfo.appId || 'ai.walfia.scorr.desktop'}</span>
            </div>
          )}

          <ul className="landing-download-features">
            <li><CheckCircle size={14} /> System install via .deb</li>
            <li><CheckCircle size={14} /> Appears in your app menu</li>
            <li><CheckCircle size={14} /> Same Sign In for every role</li>
          </ul>

          <ol className="landing-download-steps">
            <li>Click <strong>Download for Linux</strong></li>
            <li>Run <code>sudo apt install ./Scorr.deb</code></li>
            <li>Open <strong>Scorr</strong> from the app menu → Sign In</li>
          </ol>

          {desktopReady === null ? (
            <button type="button" className="btn btn-secondary landing-download-btn" disabled>
              <Loader2 size={16} className="spin-icon" /> Checking download…
            </button>
          ) : linuxReady ? (
            <>
              <a
                href={assetUrl(linuxDebHref)}
                className="btn btn-primary landing-download-btn"
                {...(/^https?:\/\//i.test(linuxDebHref)
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { download: 'Scorr.deb' })}
              >
                <Download size={18} /> Download for Linux
                {desktopInfo?.platforms?.linuxDeb?.sizeLabel
                  ? ` (${desktopInfo.platforms.linuxDeb.sizeLabel})`
                  : ''}
              </a>
              <a
                href={assetUrl(linuxDebHref)}
                className="landing-download-direct"
                {...(/^https?:\/\//i.test(linuxDebHref)
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { download: 'Scorr.deb' })}
              >
                Direct link · {/^https?:\/\//i.test(linuxDebHref) ? 'GitHub Release' : '/downloads/Scorr.deb'}
              </a>
            </>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>Linux package is being prepared — check back after the next deploy.</span>
            </div>
          )}

          {onLinux && linuxReady && (
            <p className="landing-download-note landing-download-note--highlight">
              You&apos;re on Linux — install with{' '}
              <code>sudo apt install ./Scorr.deb</code>.
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
            Roles, KPIs, automatic attendance (GPS + Wi-Fi), trusted devices, 1-hour sessions,
            app updates, and MFA — Scorr-only, step by step.
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

      <div className="landing-guide-strip landing-reveal">
        <div className="landing-guide-strip__icon">
          <Shield size={22} />
        </div>
        <div className="landing-guide-strip__copy">
          <h3>Security overview for organizations (PDF)</h3>
          <p>
            How Scorr protects company data — multi-tenant isolation, MFA & trusted devices,
            1-hour sessions, attendance location privacy, and app update integrity. Share with IT.
          </p>
        </div>
        <a
          className="btn btn-secondary landing-download-btn"
          href={SECURITY_GUIDE_PATH}
          download="Scorr-Security-Overview.pdf"
          target="_blank"
          rel="noreferrer"
        >
          <Download size={16} /> Download security PDF
        </a>
      </div>
    </section>
  );
}
