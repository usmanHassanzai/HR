import { renderToString } from 'react-dom/server';
import LandingPage from '../components/LandingPage';

/**
 * Build-time prerender for the marketing `/` route only.
 * Authenticated shells (PortalApp / platform / app=1) are never rendered here.
 */
export function renderLanding(): string {
  return renderToString(
    <LandingPage onLoginSuccess={() => { /* prerender noop */ }} />,
  );
}
