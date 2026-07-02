import { useEffect, useState } from 'react';
import { Smartphone, Download, Apple, Share, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

const APK_URL = '/downloads/scorr.apk';
const APP_URL = 'https://scorr.walfia.ai';

function isStandalonePwa(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

export default function MobileAppDownload() {
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    setInstalled(isStandalonePwa());
    fetch(APK_URL, { method: 'HEAD' })
      .then((r) => setApkReady(r.ok))
      .catch(() => setApkReady(false));
  }, []);

  const showIosInstall = () => {
    setIosHint(true);
  };

  return (
    <section id="download-app" className="landing-section landing-section--alt">
      <div className="landing-section__header landing-reveal">
        <div className="landing-section__eyebrow">Mobile App</div>
        <h2 className="landing-section__title">Install Scorr on your phone</h2>
        <p>
          Download the native Android app or install on iPhone/iPad from your browser.
          Same login — KPIs, attendance, GPS check-in, and rewards on the go.
        </p>
      </div>

      <div className="landing-download-grid landing-reveal">
        {/* Android */}
        <div className="landing-download-card">
          <div className="landing-download-card__icon landing-download-card__icon--android">
            <Smartphone size={28} />
          </div>
          <h3>Android (.apk)</h3>
          <p>Download and install directly from this website. Works on Android 8+.</p>
          <ol className="landing-download-steps">
            <li>Tap <strong>Download APK</strong> below</li>
            <li>If prompted, allow installs from your browser</li>
            <li>Open the file and tap <strong>Install</strong></li>
            <li>Allow <strong>Location</strong> when you sign in (for GPS attendance)</li>
          </ol>
          {apkReady === null ? (
            <button type="button" className="btn btn-secondary" disabled>
              <Loader2 size={16} className="spin-icon" /> Checking…
            </button>
          ) : apkReady ? (
            <a href={APK_URL} className="btn btn-primary landing-download-btn" download="scorr.apk">
              <Download size={18} /> Download APK for Android
            </a>
          ) : (
            <div className="landing-download-soon">
              <AlertCircle size={16} />
              <span>APK build coming soon — use the web app or PWA below for now.</span>
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
          <h3>iPhone &amp; iPad</h3>
          <p>
            Install as a home-screen app (no App Store required). Opens full-screen like a native app.
          </p>
          <ol className="landing-download-steps">
            <li>Open <strong>{APP_URL.replace('https://', '')}</strong> in <strong>Safari</strong></li>
            <li>Tap the <strong>Share</strong> button (square with arrow)</li>
            <li>Choose <strong>Add to Home Screen</strong></li>
            <li>Tap <strong>Add</strong> — Scorr appears on your home screen</li>
          </ol>
          {installed ? (
            <div className="landing-download-installed">
              <CheckCircle size={18} /> Scorr is installed on this device
            </div>
          ) : isIos() ? (
            <button type="button" className="btn btn-primary landing-download-btn" onClick={showIosInstall}>
              <Share size={18} /> Show install steps
            </button>
          ) : (
            <a href={APP_URL} className="btn btn-secondary landing-download-btn" target="_blank" rel="noreferrer">
              Open in Safari on iPhone
            </a>
          )}
          {iosHint && (
            <p className="landing-download-note landing-download-note--highlight">
              In Safari: Share → <strong>Add to Home Screen</strong>
            </p>
          )}
          <p className="landing-download-footnote">
            Native iOS App Store build: requires Apple Developer account + Mac/Xcode to publish.
          </p>
        </div>
      </div>
    </section>
  );
}
