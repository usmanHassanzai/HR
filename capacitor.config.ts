import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shells load the live site so Vercel deploys update Android/iOS without a
 * new store build for web-only changes. Override for local device debugging:
 *   SCORR_CAP_SERVER_URL=http://10.0.2.2:5173/?app=1
 * Set SCORR_CAP_BUNDLED=1 to ship a fully offline bundled webDir (rare).
 */
const liveUrl = process.env.SCORR_CAP_SERVER_URL || 'https://scorr.walfia.ai/?app=1';
const useBundledOnly = process.env.SCORR_CAP_BUNDLED === '1';

const config: CapacitorConfig = {
  appId: 'ai.walfia.scorr',
  appName: 'Scorr',
  webDir: 'dist',
  server: useBundledOnly
    ? {
        androidScheme: 'https',
      }
    : {
        url: liveUrl,
        cleartext: liveUrl.startsWith('http://'),
        androidScheme: 'https',
      },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#0b1120',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1120',
      overlaysWebView: false,
    },
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: true,
    backgroundColor: '#0b1120',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b1120',
  },
};

export default config;
