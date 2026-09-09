import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Phase 3 — Native App (Capacitor)
 *
 * Wraps the existing Vite web build (webDir: "dist") into native iOS / Android
 * apps for the App Store and Google Play without a rewrite.
 *
 * One-time setup:
 *   npm install
 *   npm run build
 *   npx cap add android      # and/or: npx cap add ios
 *   npm run cap:sync
 *   npx cap open android     # build & run in Android Studio / Xcode
 */
const config: CapacitorConfig = {
  appId: 'ai.walfia.scorr',
  appName: 'Scorr',
  webDir: 'dist',
  server: {
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
    // Let CSS env(safe-area-inset-*) own insets (viewport-fit=cover) — avoids double padding
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
