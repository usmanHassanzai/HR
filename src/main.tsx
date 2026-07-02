import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/dashboard.css'
import './styles/attendance.css'
import App from './App.tsx'
import { applyBranding, loadBranding } from './lib/branding'
import { initTheme } from './lib/theme'
import { initNativeApp } from './utils/nativePlatform'

initTheme()
applyBranding(loadBranding())
void initNativeApp()

// Phase 3: register service worker for PWA installability (production only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
