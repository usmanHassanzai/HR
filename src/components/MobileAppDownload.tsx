import { useEffect, useState } from 'react';
import {
  Smartphone,
  Download,
  Apple,
  Package,
  Calendar,
  Shield,
  FileText,
  Monitor,
} from 'lucide-react';
import {
  APK_PATH,
  APP_STORE_URL,
  DESKTOP_LINUX_DEB_PATH,
  DESKTOP_WIN_PATH,
  LINUX_DESKTOP_VERSION,
  WINDOWS_DESKTOP_VERSION,
  IPA_PATH,
  IOS_PWA_INSTALL_URL,
  PLAY_STORE_LIVE,
  PLAY_STORE_URL,
  androidInstallHref,
  androidInstallIsDownload,
  isApkDirectDownloadAvailable,
  iosInstallHref,
  iosInstallIsAppStore,
  iosInstallIsIpa,
  iosOtaInstallHref,
  showStoreInstallCtas,
} from '../utils/appStoreLinks';

const BUILD_INFO_PATH = '/downloads/build-info.json';
const VERSION_JSON_PATH = '/downloads/version.json';
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
  installMethod?: string;
  ipaAvailable?: boolean;
  ipaFilename?: string;
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

interface VersionManifest {
  android?: { versionName?: string };
  linux?: { version?: string; debUrl?: string };
  windows?: { version?: string; setupUrl?: string };
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

async function fetchVersionManifest(): Promise<VersionManifest | null> {
  try {
    const r = await fetch(assetUrl(VERSION_JSON_PATH), { cache: 'no-store' });
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

async function checkIpaAvailable(): Promise<boolean> {
  try {
    const r = await fetch(assetUrl(IPA_PATH), { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return false;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const length = Number(r.headers.get('content-length') || 0);
    if (type.includes('text/html')) return false;
    return length > 1_000_000 || type.includes('octet-stream') || type.includes('zip') || type.includes('iphone');
  } catch {
    return false;
  }
}

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
  const [versionManifest, setVersionManifest] = useState<VersionManifest | null>(null);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [ipaReady, setIpaReady] = useState<boolean | null>(null);
  const [desktopReady, setDesktopReady] = useState<{
    win: boolean;
    deb: boolean;
  } | null>(null);
  const [ua, setUa] = useState<{ ios: boolean; android: boolean; win: boolean; linux: boolean } | null>(null);
  const apkWindowOpen = isApkDirectDownloadAvailable();

  const androidInfo = buildInfo?.android;
  const iosInfo = buildInfo?.ios;
  const desktopInfo = buildInfo?.desktop;
  const ipaAvailable = Boolean(iosInfo?.ipaAvailable) || ipaReady === true;
  const iosIsIpa = iosInstallIsIpa({ ipaAvailable });
  const iosIsStore = iosInstallIsAppStore();
  const onIos = ua?.ios === true;
  const onAndroid = ua?.android === true;
  const onWindows = ua?.win === true;
  const onLinux = ua?.linux === true;
  const androidHref = androidInstallHref();
  const androidIsFile = androidInstallIsDownload();

  const winHref =
    versionManifest?.windows?.setupUrl
    || desktopInfo?.platforms?.windows?.url
    || DESKTOP_WIN_PATH;
  const linuxDebHref =
    versionManifest?.linux?.debUrl
    || desktopInfo?.platforms?.linuxDeb?.url
    || DESKTOP_LINUX_DEB_PATH;
  const windowsVersion = versionManifest?.windows?.version || desktopInfo?.version || WINDOWS_DESKTOP_VERSION;
  const linuxVersion = versionManifest?.linux?.version || LINUX_DESKTOP_VERSION;

  const winReady = desktopReady === null || desktopReady.win === true;
  const linuxReady = desktopReady === null || desktopReady.deb === true;

  useEffect(() => {
    if (!showStoreInstallCtas()) return;
    setUa({
      ios: isIos(),
      android: isAndroid(),
      win: isWindowsUa(),
      linux: isLinuxUa(),
    });
    void (async () => {
      const [info, manifest] = await Promise.all([fetchBuildInfo(), fetchVersionManifest()]);
      setBuildInfo(info);
      setVersionManifest(manifest);
      if (!apkWindowOpen) {
        setApkReady(false);
      } else {
        const headOk = await checkApkAvailable();
        setApkReady(headOk || info?.android?.available === true);
      }

      const ipaHeadOk = await checkIpaAvailable();
      setIpaReady(ipaHeadOk || info?.ios?.ipaAvailable === true);

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

  if (!showStoreInstallCtas()) return null;

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Downloads</div>
        <h2 className="landing-section__title">Download Scorr</h2>
        <p>
          Windows {windowsVersion}, Linux {linuxVersion}, and Android {versionManifest?.android?.versionName || '1.3.53'} use the same Sign In as the website.
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

          <h3>Android</h3>
          <p>Install the phone app, then sign in with the same company account.</p>

          {androidInfo && apkReady && (
            <div className="landing-download-meta">
              <span>
                <Package size={14} />{' '}
                {versionManifest?.android?.versionName ? `v${versionManifest.android.versionName}` : 'Android'}
                {androidInfo.sizeLabel ? ` · ${androidInfo.sizeLabel}` : ''}
              </span>
              <span><Calendar size={14} /> Updated {androidInfo.updatedLabel}</span>
              <span><Shield size={14} /> {androidInfo.appId || 'ai.walfia.scorr'}</span>
            </div>
          )}

          {PLAY_STORE_LIVE ? (
            <a
              href={PLAY_STORE_URL}
              className="btn btn-primary landing-download-btn"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download size={18} /> Get it on Google Play
            </a>
          ) : (
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
            </>
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
              {iosIsStore ? 'App Store' : iosIsIpa ? 'Native IPA ready' : 'Native iOS app'}
            </span>
          </div>

          <h3>iPhone</h3>
          <p>Open Scorr in Safari and add it to the Home Screen until the App Store listing is live.</p>

          {(iosInfo?.version || iosInfo?.sizeLabel) && (
            <div className="landing-download-meta">
              {iosInfo.version && (
                <span><Package size={14} /> v{iosInfo.version}{iosInfo.sizeLabel ? ` · ${iosInfo.sizeLabel}` : ''}</span>
              )}
              {iosInfo.updatedLabel && (
                <span><Calendar size={14} /> Updated {iosInfo.updatedLabel}</span>
              )}
              <span><Shield size={14} /> {iosInfo.appId || 'ai.walfia.scorr'}</span>
            </div>
          )}

          {iosIsStore ? (
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
          ) : iosIsIpa ? (
            <>
              <ol className="landing-download-steps">
                <li>On iPhone (Safari): tap <strong>Install Scorr</strong> below</li>
                <li>Trust the developer if iOS asks (Settings → General → VPN &amp; Device Management)</li>
                <li>Open Scorr → sign in → Location → <strong>Always</strong> for auto attendance</li>
              </ol>
              <a
                href={typeof window !== 'undefined' ? iosOtaInstallHref(window.location.origin) : iosOtaInstallHref()}
                className="btn btn-primary landing-download-btn"
              >
                <Apple size={18} /> Install Scorr on iPhone
                {iosInfo?.sizeLabel ? ` (${iosInfo.sizeLabel})` : ''}
              </a>
              <a
                href={assetUrl(IPA_PATH)}
                className="landing-download-direct"
                download="scorr.ipa"
              >
                Direct IPA · /downloads/scorr.ipa
              </a>
              {onIos && (
                <p className="landing-download-note landing-download-note--highlight">
                  You&apos;re on iPhone — tap Install above (Safari). Ad Hoc builds must include this device UDID.
                </p>
              )}
            </>
          ) : (
            <>
              <a
                href={IOS_PWA_INSTALL_URL}
                className="btn btn-secondary landing-download-btn"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Apple size={18} /> Open Scorr on iPhone
              </a>
              <p className="landing-download-footnote">
                On iPhone, open this page in Safari and sign in. The App Store listing will appear here when it is published.
              </p>
            </>
          )}
        </div>

        <div id="download-windows" className="landing-download-card landing-download-card--windows">
          <div className="landing-download-card__head">
            <div className="landing-download-card__icon landing-download-card__icon--windows">
              <Monitor size={28} />
            </div>
            <span className="landing-download-badge landing-download-badge--live">Version {windowsVersion}</span>
          </div>

          <h3>Windows {windowsVersion}</h3>
          <p>Setup adds Start Menu and Desktop shortcuts, then opens Sign In.</p>

          <div className="landing-download-meta">
            <span>
              <Package size={14} /> Version {windowsVersion}
              {desktopInfo?.platforms?.windows?.sizeLabel ? ` · ${desktopInfo.platforms.windows.sizeLabel}` : ''}
            </span>
            <span><Calendar size={14} /> Updated {desktopInfo?.updatedLabel || 'November 6, 2026'}</span>
          </div>

          <a
            href={assetUrl(winHref)}
            className="btn btn-primary landing-download-btn"
            {...(/^https?:\/\//i.test(winHref)
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : { download: 'Scorr-Setup.exe' })}
          >
            <Download size={18} /> Download Windows {windowsVersion}
            {desktopInfo?.platforms?.windows?.sizeLabel
              ? ` (${desktopInfo.platforms.windows.sizeLabel})`
              : ''}
          </a>

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
            <span className="landing-download-badge landing-download-badge--live">Version {linuxVersion}</span>
          </div>

          <h3>Linux {linuxVersion}</h3>
          <p>Install the .deb on Ubuntu or Debian, or use the AppImage if you want automatic updates.</p>

          {desktopInfo?.platforms?.linuxDeb && (
            <div className="landing-download-meta">
              <span>
                <Package size={14} />{' '}
                Version {linuxVersion}
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

          <a
            href={assetUrl(linuxDebHref)}
            className="btn btn-primary landing-download-btn"
            {...(/^https?:\/\//i.test(linuxDebHref)
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : { download: 'Scorr.deb' })}
          >
            <Download size={18} /> Download Linux {linuxVersion}
            {desktopInfo?.platforms?.linuxDeb?.sizeLabel
              ? ` (${desktopInfo.platforms.linuxDeb.sizeLabel})`
              : ''}
          </a>

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
