import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function isAndroidApp(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIosApp(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

/** Initialize native shell (status bar, back button). Safe to call on web. */
export async function initNativeApp(): Promise<void> {
  if (!isNativeApp()) return;

  document.documentElement.classList.add('native-app');
  document.body.classList.add('native-app');

  try {
    await StatusBar.setStyle({ style: Style.Dark });
    if (isAndroidApp()) {
      await StatusBar.setBackgroundColor({ color: '#0b1120' });
    }
  } catch {
    // Status bar plugin may be unavailable in some WebView builds.
  }

  if (isAndroidApp()) {
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
  }

  window.addEventListener('load', () => {
    void SplashScreen.hide();
  });
}
