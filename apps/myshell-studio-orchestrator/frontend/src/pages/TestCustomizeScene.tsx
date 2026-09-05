import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import CustomizeSceneModal from '../components/CustomizeSceneModal';

/**
 * Test-only harness route: /__test-customize-scene?state=free-default|vip-clicked|vip-unlocked
 * Used by automated L1 rendering tests (miniapp-delivery-flywheel).
 * Does NOT require backend — VIP status is forced via the `vipOverride` prop
 * rather than the EnergyContext.
 */
export default function TestCustomizeScene() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state') || 'free-default';

  const vipOverride = state === 'vip-unlocked';

  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <div className="p-8 text-Cr-text-default-v2">
        <div data-testid="harness-closed">closed</div>
      </div>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <div data-testid="harness-root" data-state={state}>
        <CustomizeSceneModal
          botId="1745258157"
          slugId="test-blowjob"
          vipOverride={vipOverride}
          onClose={() => setOpen(false)}
          onSubmit={() => {
            (window as unknown as { __harnessSubmitted?: boolean }).__harnessSubmitted = true;
          }}
          onRequestUpgrade={() => {
            (window as unknown as { __harnessUpgradeRequested?: boolean }).__harnessUpgradeRequested = true;
          }}
        />
      </div>
    </I18nextProvider>
  );
}
