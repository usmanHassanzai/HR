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
      backgroundColor: '#0b1120',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1120',
    },
  },
  ios: {
    contentInset: 'always',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
