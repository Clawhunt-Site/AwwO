import { Component, type ReactNode } from 'react';

/** Keeps a lazily loaded part that fails to load — its chunk gone after a deploy, a dropped request —
 * from reaching the root boundary, which would replace the whole app with an error screen. */
export class LazyBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
