import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/dashboard.css'
import './styles/attendance.css'
import './styles/departments.css'
import './styles/mobile-app.css'
import './styles/platform.css'
import './styles/company-register.css'
import App from './App.tsx'
import { applyBranding, loadBranding } from './lib/branding'
import { initTheme } from './lib/theme'
import { initNativeApp, isNativeApp } from './utils/nativePlatform'

initTheme()
applyBranding(loadBranding())
void initNativeApp()

// Service worker — website/PWA only (not inside native APK)
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
