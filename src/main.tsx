import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './styles/fonts'
import './index.css'
import './styles/responsive-layout.css'
import './styles/mobile-drawer-nav.css'
import './styles/app-header.css'
import './styles/dashboard.css'
import './styles/mobile-app.css'
import './styles/mobile-polish.css'
import App from './App.tsx'
import { applyBranding, loadBranding } from './lib/branding'
import { initTheme } from './lib/theme'
import {
  initNativeApp,
  isAppShell,
  isElectronShell,
  isNativeApp,
} from './utils/nativePlatform'
import { isDeleteAccountRoute, isPlatformRoute } from './utils/companyHelpers'

initTheme()
applyBranding(loadBranding())
void initNativeApp()

// One-shot reload when a lazy chunk 404s / CSS preload fails (stale cache or bad MIME).
const CHUNK_RELOAD_KEY = 'scorr-chunk-reload'
const VITE_PRELOAD_RELOAD_KEY = 'scorr-vite-preload-reload'
function isDynamicImportFailure(reason: unknown): boolean {
  const msg = String(
    reason instanceof Error ? reason.message : reason ?? '',
  )
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    msg,
  )
}
function reloadOnceForStaleChunk(): void {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
  } catch {
    /* private mode — still attempt one reload */
  }
  window.location.reload()
}
window.addEventListener('unhandledrejection', (event) => {
  if (isDynamicImportFailure(event.reason)) reloadOnceForStaleChunk()
})
window.addEventListener('error', (event) => {
  if (isDynamicImportFailure(event.message) || isDynamicImportFailure(event.error)) {
    reloadOnceForStaleChunk()
  }
})
// Vite fires this when a CSS/JS preload fails (e.g. CSS served as text/plain).
window.addEventListener('vite:preloadError', ((event: Event) => {
  const e = event as Event & { preventDefault?: () => void }
  try {
    e.preventDefault?.()
  } catch {
    /* ignore */
  }
  try {
    if (sessionStorage.getItem(VITE_PRELOAD_RELOAD_KEY)) return
    sessionStorage.setItem(VITE_PRELOAD_RELOAD_KEY, '1')
  } catch {
    /* still reload once */
  }
  window.location.reload()
}) as EventListener)

// Service worker — website/PWA only (never Capacitor or Electron / scorr-desktop)
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeApp() && !isElectronShell()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        void reg.update()
      })
      .catch(() => {})
  })
} else if ('serviceWorker' in navigator && isElectronShell()) {
  // Drop any SW left over from opening the same origin in Chrome.
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => {
      void r.unregister()
    })
  })
}

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Missing #root')
}

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
)

/**
 * Hydrate only when this document is the prerendered marketing `/` shell.
 * Authenticated / app-shell / platform routes clear the static HTML and mount fresh
 * so we never hydrate landing markup into a portal tree (mismatch).
 */
const hasPrerender =
  rootEl.getAttribute('data-prerender') === 'landing' && rootEl.hasChildNodes()

const isMarketingHome =
  window.location.pathname === '/'
  && !isAppShell()
  && !isPlatformRoute()
  && !isDeleteAccountRoute()

if (hasPrerender && isMarketingHome) {
  hydrateRoot(rootEl, tree)
} else {
  if (hasPrerender) {
    rootEl.removeAttribute('data-prerender')
    rootEl.replaceChildren()
  }
  createRoot(rootEl).render(tree)
}
