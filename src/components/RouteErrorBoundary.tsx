import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * Catches lazy-route / chunk preload failures so Electron never stays on a blank page.
 */
export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[scorr] RouteErrorBoundary', error, info?.componentStack);
  }

  private reload = () => {
    try {
      sessionStorage.removeItem('scorr-vite-preload-reload');
      sessionStorage.removeItem('scorr-chunk-reload');
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '1.5rem',
          textAlign: 'center',
          background: 'var(--bg-app, #f1f5f9)',
          color: 'var(--text-primary, #0f172a)',
          fontFamily: 'system-ui, sans-serif',
        }}
        role="alert"
      >
        <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Something went wrong</p>
        <p style={{ margin: 0, maxWidth: '22rem', color: 'var(--text-secondary, #64748b)', lineHeight: 1.45 }}>
          The screen failed to load. Reload to try again — your login stays signed in.
        </p>
        <button
          type="button"
          onClick={this.reload}
          style={{
            marginTop: '0.25rem',
            padding: '0.65rem 1.25rem',
            border: 0,
            borderRadius: 10,
            background: '#0d9488',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
