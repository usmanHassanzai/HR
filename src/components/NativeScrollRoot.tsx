import { ReactNode } from 'react';
import { isAppShell } from '../utils/nativePlatform';

interface NativeScrollRootProps {
  children: ReactNode;
}

/**
 * Single scroll container for APK / installed app.
 * Android WebView fails when the whole page uses nested flex + 100dvh traps.
 */
export default function NativeScrollRoot({ children }: NativeScrollRootProps) {
  if (!isAppShell()) return <>{children}</>;
  return <div className="native-scroll-root">{children}</div>;
}
