import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { publishBoardNav, registerBoardHomeNav } from './companyBoardNav';
import { isGlobalPath } from '@/lib/company-routes';
import { useCompany } from '@/context/CompanyContext';

// Reports the embedded board's nav level (full-page company directory "home" vs a
// specific company's workspace) to super's team-page topbar, and registers how to step
// back to the directory. Mounted inside the board's MemoryRouter + CompanyProvider so it
// can read the route and the selected company. The back hierarchy lives in super's
// chrome; the vendored board's own breadcrumb is left untouched. Extracted from
// CompanyBoard so it can be unit-tested without mounting the whole board app.
export function BoardNavReporter() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  // "Inside a company" = a company is selected AND we're on one of its workspace routes —
  // NOT the full-page directory (`/companies`), the onboarding wizard (`/onboarding`), or
  // any global/auth route (`/auth`, `/invite`, `/instance`, `/`, …). Deriving from
  // selectedCompany + an explicit non-company-route check (rather than parsing the route's
  // first segment) is robust both ways: a company-scoped settings route still counts as
  // in-company (`/<prefix>/company/settings/instance/*`), and a global/`onboarding` first
  // segment is never mistaken for a company prefix. The disappearing-on-settings bug was
  // NOT in this predicate — it was the nav-cleanup misfire fixed below.
  const path = location.pathname;
  const onNonCompanyRoute =
    path === '/companies' ||
    path === '/onboarding' ||
    path === '/tests/perf/long-thread' ||
    path.startsWith('/ux-lab/') ||
    isGlobalPath(path);
  const inCompany = !onNonCompanyRoute && Boolean(selectedCompany);
  const companyName = inCompany ? selectedCompany?.name ?? null : null;

  React.useEffect(() => {
    publishBoardNav({ inCompany, companyName });
  }, [inCompany, companyName]);

  // Register "step up to the directory" and clear the published nav state — both ONLY on
  // mount/unmount. `navigate` is read through a ref so this effect never re-runs on
  // in-board navigation. Coupling the cleanup to `[navigate]` was the bug: `useNavigate()`
  // returns a fresh function on route changes, so the cleanup fired on every navigation
  // and published `inCompany:false`. The publish effect above only re-fires when
  // inCompany/companyName actually change, so once you were already "in a company" (e.g.
  // dashboard → settings, true → true), nothing re-published true and super's topbar
  // trail got stuck without the company crumb.
  const navigateRef = React.useRef(navigate);
  navigateRef.current = navigate;
  React.useEffect(() => {
    registerBoardHomeNav(() => navigateRef.current('/companies'));
    return () => {
      registerBoardHomeNav(null);
      publishBoardNav({ inCompany: false, companyName: null });
    };
  }, []);

  return null;
}
