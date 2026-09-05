import React from 'react';
import { readInitialLocale } from './locale';

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  info: string | null;
};

// Root-level safety net. Without it, ANY throw during render unmounts the whole
// tree and leaves a silent blank-white window — which is exactly what the desktop
// (`tauri://`) shell showed at startup, with no clue why. Here we instead paint a
// visible, styled error card carrying the message + component stack, so a failure
// is diagnosable (and screenshot-able) rather than invisible. It also tears down
// the pre-React HTML splash (`#superclaw-startup-splash`) so the error is not left
// hidden behind it.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the console (devtools / Tauri logs) AND keep it on-screen.
    // eslint-disable-next-line no-console
    console.error('[AwwO] startup/render error:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
    const splash = typeof document !== 'undefined' ? document.getElementById('superclaw-startup-splash') : null;
    splash?.remove();
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const isZh = readInitialLocale() === 'zh';
    return (
      <main className="startup-screen" role="alert" aria-live="assertive">
        <section
          className="startup-card"
          aria-label={isZh ? 'AwwO 启动错误' : 'AwwO startup error'}
          style={{
            // .startup-card is now a transparent, centered splash column; the error
            // card needs its own bordered box + left alignment, so restore those here.
            alignItems: 'flex-start',
            textAlign: 'left',
            gap: 16,
            maxWidth: 'min(620px, calc(100vw - 48px))',
            padding: 18,
            borderRadius: 16,
            border: '1px solid var(--border-light)',
            background: 'var(--bg-card)',
            boxShadow: 'var(--shadow-soft)',
          }}
        >
          <div className="startup-copy" style={{ gap: 8 }}>
            <span className="startup-product-name">{isZh ? 'AwwO 启动失败' : 'AwwO failed to start'}</span>
            <span>
              {isZh
                ? '界面渲染时出错。请把这一屏截图发给支持，下面是错误详情：'
                : 'The interface hit a render error. Please screenshot this and share it; details below:'}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              width: '100%',
              maxHeight: '38vh',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              lineHeight: 1.5,
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--border-light)',
              background: 'var(--bg-muted)',
              color: 'var(--text-primary)',
            }}
          >
            {String(error.stack || error.message || error)}
            {info ? `\n\n— component stack —${info}` : ''}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              alignSelf: 'flex-start',
              padding: '8px 16px',
              borderRadius: 10,
              border: '1px solid var(--border-light)',
              background: 'var(--text-primary)',
              color: 'var(--bg-card)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isZh ? '重新加载' : 'Reload'}
          </button>
        </section>
      </main>
    );
  }
}
