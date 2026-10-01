import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './styles/fonts'
import './index.css'
import './styles/responsive-layout.css'
import './styles/mobile-drawer-nav.css'
import './styles/app-header.css'
import './styles/dashboard.css'
import './styles/mobile-app.css'
import App from './App.tsx'
import { applyBranding, loadBranding } from './lib/branding'
import { initTheme } from './lib/theme'
import { initNativeApp, isAppShell, isNativeApp } from './utils/nativePlatform'
import { isPlatformRoute } from './utils/companyHelpers'

initTheme()
applyBranding(loadBranding())
void initNativeApp()

// Service worker — website/PWA only (not inside native APK)
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
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

if (hasPrerender && isMarketingHome) {
  hydrateRoot(rootEl, tree)
} else {
  if (hasPrerender) {
    rootEl.removeAttribute('data-prerender')
    rootEl.replaceChildren()
  }
  createRoot(rootEl).render(tree)
}
