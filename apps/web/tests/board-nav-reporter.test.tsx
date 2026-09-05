import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

// BoardNavReporter reads the board's selected company from CompanyContext. Stub it so
// the test controls "is a company selected" without mounting the whole board app.
const selectedCompanyRef: { current: { name: string } | null } = { current: { name: 'Acme' } };
vi.mock('@/context/CompanyContext', () => ({
  useCompany: () => ({ selectedCompany: selectedCompanyRef.current }),
}));

import { BoardNavReporter } from '../src/BoardNavReporter';
import { goToCompanyList, publishBoardNav, useBoardNavState } from '../src/companyBoardNav';

function Probe() {
  const nav = useBoardNavState();
  return <div data-testid="probe">{JSON.stringify(nav)}</div>;
}

function NavButtons() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/ACME/dashboard')}>dash</button>
      <button onClick={() => navigate('/ACME/company/settings')}>settings</button>
      <button onClick={() => navigate('/ACME/company/settings/instance/profile')}>instance</button>
      <button onClick={() => navigate('/companies')}>directory</button>
      <button onClick={() => navigate('/onboarding')}>onboarding</button>
      <button onClick={() => navigate('/auth')}>auth</button>
      <button onClick={() => navigate('/ux-lab/cloud-upstream')}>uxlab</button>
    </>
  );
}

function readProbe() {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}');
}

function setup(initial = '/ACME/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <BoardNavReporter />
      <Probe />
      <NavButtons />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  selectedCompanyRef.current = { name: 'Acme' };
  publishBoardNav({ inCompany: false, companyName: null }); // reset the module-level bridge
});
afterEach(() => cleanup());

describe('BoardNavReporter → super topbar nav state', () => {
  it('reports the company on a company-scoped route', () => {
    setup('/ACME/dashboard');
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });
  });

  it('keeps the company across in-board navigation, including settings (regression)', () => {
    // Before the fix, the [navigate]-coupled cleanup published {inCompany:false} on every
    // navigation, and the value-keyed publish effect did not re-fire while inCompany stayed
    // true (dashboard → settings), so super's trail lost the company crumb and never recovered.
    setup('/ACME/dashboard');
    expect(readProbe().inCompany).toBe(true);

    fireEvent.click(screen.getByText('settings'));
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });

    fireEvent.click(screen.getByText('instance'));
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });
  });

  it('drops the company on the directory, onboarding, and global routes, and recovers on return', () => {
    setup('/ACME/dashboard');

    fireEvent.click(screen.getByText('directory'));
    expect(readProbe().inCompany).toBe(false);

    fireEvent.click(screen.getByText('settings')); // back inside the company
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });

    fireEvent.click(screen.getByText('onboarding')); // the wizard is not a company
    expect(readProbe().inCompany).toBe(false);

    fireEvent.click(screen.getByText('settings'));
    fireEvent.click(screen.getByText('auth')); // a global/auth route is not a company
    expect(readProbe().inCompany).toBe(false);

    fireEvent.click(screen.getByText('settings'));
    fireEvent.click(screen.getByText('uxlab')); // dev-only lab routes are not a company
    expect(readProbe().inCompany).toBe(false);
  });

  it('steps back to the directory through the registered goToCompanyList bridge', () => {
    setup('/ACME/dashboard');
    expect(readProbe().inCompany).toBe(true);

    // Drive the host-side bridge callback (registered by BoardNavReporter), not a test
    // navigate — proves registerBoardHomeNav wired the board's navigate to the directory.
    act(() => goToCompanyList());
    expect(readProbe().inCompany).toBe(false);
  });

  it('clears the published state and unregisters the home-nav callback on unmount', () => {
    const view = setup('/ACME/dashboard');
    expect(readProbe().inCompany).toBe(true);

    view.unmount();
    render(<Probe />);
    expect(readProbe().inCompany).toBe(false);

    // The cleanup also unregisters goToCompanyList; a stale callback would throw or
    // re-publish. After unmount it must be a safe no-op (no leaked navigate closure).
    expect(() => act(() => goToCompanyList())).not.toThrow();
    expect(readProbe().inCompany).toBe(false);
  });

  it('leaves no residual nav state under StrictMode double-invocation', () => {
    const view = render(
      <React.StrictMode>
        <MemoryRouter initialEntries={['/ACME/dashboard']}>
          <BoardNavReporter />
          <Probe />
          <NavButtons />
        </MemoryRouter>
      </React.StrictMode>,
    );
    // After the dev double mount→unmount→mount, the final published state is correct…
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });
    fireEvent.click(screen.getByText('settings'));
    expect(readProbe()).toEqual({ inCompany: true, companyName: 'Acme' });
    // …and a real unmount still clears it (no leaked listener keeps it true).
    view.unmount();
    render(<Probe />);
    expect(readProbe().inCompany).toBe(false);
  });
});
