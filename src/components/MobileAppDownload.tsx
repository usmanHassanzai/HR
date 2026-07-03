import { useEffect, useState } from 'react';
import { Smartphone, Download, Apple, Share, CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react';

const APK_PATH = '/downloads/scorr.apk';
const IPA_PATH = '/downloads/scorr.ipa';
const TESTFLIGHT_URL = import.meta.env.VITE_TESTFLIGHT_URL as string | undefined;

function assetUrl(path: string): string {
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}

const APP_URL = typeof window !== 'undefined' ? window.location.origin : 'https://walfiaai.vercel.app';

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

async function checkBinary(path: string, types: string[]): Promise<boolean> {
  try {
    const r = await fetch(assetUrl(path), { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html') && types.some((t) => type.includes(t));
  } catch {
    return false;
  }
}

export default function MobileAppDownload() {
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [ipaReady, setIpaReady] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    setInstalled(isStandalonePwa());
    void checkBinary(APK_PATH, ['android', 'octet-stream', 'zip']).then(setApkReady);
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
        <h2 className="landing-section__title">Install Scorr on your phone</h2>
        <p>
          Native Android APK, iPhone home-screen app, or TestFlight — same login, KPIs, shifts,
          GPS attendance, and rewards on the go.
        </p>
      </div>

      <div className="landing-download-grid landing-reveal">
        {/* Android */}
        <div className="landing-download-card">
          <div className="landing-download-card__icon landing-download-card__icon--android">
            <Smartphone size={28} />
          </div>
          <h3>Android app (.apk)</h3>
          <p>
            Installs <strong>Scorr</strong> as a real app — opens directly to sign-in (not the marketing site).
          </p>
          <ol className="landing-download-steps">
            <li>Tap <strong>Download &amp; Install APK</strong></li>
            <li>Open <strong>Downloads</strong> and tap the file</li>
            <li>Allow install from browser if prompted</li>
            <li>Open Scorr → sign in → allow <strong>Location</strong></li>
          </ol>
          {apkReady === null ? (
            <button type="button" className="btn btn-secondary" disabled>
              <Loader2 size={16} className="spin-icon" /> Checking…
            </button>
          ) : apkReady ? (
            <>
              <button type="button" className="btn btn-primary landing-download-btn" onClick={downloadApk}>
                <Download size={18} /> Download &amp; Install APK
              </button>
              <a href={assetUrl(APK_PATH)} className="landing-download-direct" download="scorr.apk">
                Direct link: {assetUrl(APK_PATH)}
              </a>
            </>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>APK build coming soon — use the web app for now.</span>
            </div>
          )}
          {isAndroid() && apkReady && (
            <p className="landing-download-note">You&apos;re on Android — tap the button above to install.</p>
          )}
        </div>

        {/* iOS */}
        <div className="landing-download-card">
          <div className="landing-download-card__icon landing-download-card__icon--ios">
            <Apple size={28} />
          </div>
          <h3>iPhone &amp; iPad app</h3>
          <p>
            Same native experience as Android — sign-in screen, dashboards, GPS attendance.
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
              <Apple size={18} /> Get iOS install link
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
              style={{ marginTop: '0.5rem' }}
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
              Native App Store / TestFlight build: run <code>node scripts/build-ios-ipa.mjs --archive</code> on a Mac,
              or use GitHub Actions → Build iOS.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
