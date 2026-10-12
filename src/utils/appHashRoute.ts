/** Hash routes for the signed-in portal: `#app`, `#app/<tab>`, `#app/<tab>/<sub>`. */

export type AppHashParts = {
  tab?: string;
  sub?: string;
};

function readHistoryState(): Record<string, unknown> {
  const st = window.history.state;
  return st && typeof st === 'object' ? { ...(st as Record<string, unknown>) } : {};
}

export function isLoginHash(hash = window.location.hash): boolean {
  return hash.replace(/^#/, '') === 'login';
}

export function isAppHash(hash = window.location.hash): boolean {
  const h = hash.replace(/^#/, '').trim();
  return h === 'app' || h.startsWith('app/');
}

export function parseAppHash(hash = window.location.hash): AppHashParts | null {
  const h = hash.replace(/^#/, '').trim();
  if (!h || h === 'login') return null;
  if (h === 'app') return {};
  if (!h.startsWith('app/')) return null;
  const parts = h.slice(4).split('/').filter(Boolean);
  return { tab: parts[0], sub: parts[1] };
}

/** Replace URL hash with an app work route (keeps history.state keys). */
export function writeAppHash(tab?: string, sub?: string): void {
  try {
    const parts = ['app'];
    if (tab) parts.push(tab);
    if (tab && sub) parts.push(sub);
    const nextHash = `#${parts.join('/')}`;
    if (window.location.hash === nextHash) return;
    const url = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState({ ...readHistoryState(), scorrApp: 'dashboard' }, '', url);
  } catch {
    /* ignore */
  }
}

/** Leave marketing `#login` once the portal is (or will be) shown. */
export function leaveLoginHash(fallbackTab?: string, fallbackSub?: string): void {
  if (!isLoginHash() && window.location.hash !== '') {
    if (!isAppHash()) writeAppHash(fallbackTab, fallbackSub);
    return;
  }
  writeAppHash(fallbackTab, fallbackSub);
}

export function clearAppHashToRoot(): void {
  try {
    if (!window.location.hash) return;
    const url = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(readHistoryState(), '', url);
  } catch {
    /* ignore */
  }
}
