/**
 * 1.3.45 preload has no wifiDiagnostics or openLocationSettings.
 * Do not call either. The panel stays hidden on that bridge.
 */
export default function DesktopWifiDiagnostics({ compact = false }: { compact?: boolean }) {
  return compact ? null : null;
}
