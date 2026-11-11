// Where the launch notice (LaunchNotice.tsx) may open: a workspace's home, for an account the tutorial is done with.
// Both are read once, when the page loads, so finishing the tutorial on this page does not bring a second dialog after
// it; the notice comes on the next visit. Its code loads only then.
import { lazy, Suspense, useState } from 'react';
import type { Identity } from './api';
import { LazyBoundary } from './LazyBoundary';
import { launchNoticeTenant, tutorialSettled } from './SaaSOnboarding';

const LaunchNotice = lazy(() => import('./LaunchNotice'));

export function LaunchNoticeHost({ identity }: { identity: Identity }) {
  const [tenantId] = useState(() => tutorialSettled(identity) ? launchNoticeTenant(identity, location.search, location.pathname) : null);
  // A notice that cannot load is simply not shown: nothing depends on it.
  return tenantId ? <LazyBoundary fallback={null}><Suspense fallback={null}><LaunchNotice userID={identity.user.id} tenantId={tenantId} /></Suspense></LazyBoundary> : null;
}
