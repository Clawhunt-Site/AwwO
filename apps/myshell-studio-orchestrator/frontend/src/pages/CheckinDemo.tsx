import { useState, useCallback } from 'react';
import CheckinModal from '../components/Checkin/CheckinModal';
import { resetMockCheckin } from '../services/checkin';
import { useCheckin } from '../contexts/CheckinContext';

const AUTO_OPEN_KEY = 'dreamy_checkin_last_auto_open_date';

/**
 * Demo page for QA preview of the Daily Check-in modal.
 * Route: /checkin-demo  (?page=checkin-demo)
 */
export default function CheckinDemo() {
  const [open, setOpen] = useState(false);
  const [mockStreak, setMockStreak] = useState(0);
  const checkin = useCheckin();

  const handleOpen = useCallback((streak: number) => {
    resetMockCheckin(streak);
    setMockStreak(streak);
    setOpen(true);
  }, []);

  const handleSimulateFirstOpen = useCallback(() => {
    localStorage.removeItem(AUTO_OPEN_KEY);
    window.location.reload();
  }, []);

  const lastAutoDate = localStorage.getItem(AUTO_OPEN_KEY) ?? '(none)';

  return (
    <div className="min-h-screen bg-Cr-Bg-soft-v2 p-4 flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-Cr-text-static-white-v2">
        Check-in Modal Demo
      </h1>
      <p className="text-sm text-Cr-text-subtle-v2">
        Tap a button to open the check-in modal in different states.
        Mock mode is always on in this demo.
      </p>

      {/* ── Phase 2: Context state panel ── */}
      <div className="p-3 rounded-lg-v2 bg-Cr-Bg-surface-default-v2 flex flex-col gap-1.5">
        <div className="text-sm font-semibold text-Cr-text-default-v2">Context State</div>
        <Row label="todayClaimed" value={String(checkin.status?.todayClaimed ?? '—')} />
        <Row label="Red dot visible" value={checkin.status && !checkin.status.todayClaimed ? 'YES' : 'no'} />
        <Row label="isModalOpen" value={String(checkin.isModalOpen)} />
        <Row label="autoOpenedToday" value={String(checkin.autoOpenedToday)} />
        <Row label="Last auto-open date" value={lastAutoDate} />
        <Row label="loading" value={String(checkin.loading)} />
        <Row label="error" value={checkin.error ?? '(none)'} />
      </div>

      {/* ── Phase 2: Simulate first-open ── */}
      <DemoButton
        label="Simulate First Open (clear localStorage + reload)"
        description="Clears dreamy_checkin_last_auto_open_date and reloads. If claimable, modal auto-pops."
        onClick={handleSimulateFirstOpen}
        highlight
      />

      {/* ── Phase 2: Open via context (sidebar source) ── */}
      <DemoButton
        label="Open via Context (sidebar)"
        description="Calls checkinContext.openModal('sidebar') — same as sidebar entry"
        onClick={() => checkin.openModal('sidebar')}
      />

      <div className="h-px bg-white/8" />

      <div className="flex flex-col gap-3">
        <DemoButton
          label="Day 1 (Fresh Start)"
          description="No streak, first day of cycle"
          onClick={() => handleOpen(0)}
        />
        <DemoButton
          label="Day 3 (Bonus Day)"
          description="2 days claimed, Day 3 has Extra+10 bonus"
          onClick={() => handleOpen(2)}
        />
        <DemoButton
          label="Day 5 (Mid Cycle)"
          description="4 days claimed, halfway there"
          onClick={() => handleOpen(4)}
        />
        <DemoButton
          label="Day 7 (Big Reward!)"
          description="6 days claimed, Self Director x3 reward"
          onClick={() => handleOpen(6)}
        />
        <DemoButton
          label="Already Claimed Today"
          description="Day 3 claimed, shows disabled CTA"
          onClick={() => {
            resetMockCheckin(3, true);
            setMockStreak(3);
            setOpen(true);
          }}
        />
      </div>

      <p className="text-xs text-Cr-text-subtler-v2 mt-4">
        Current mock streak: {mockStreak} | Build: Phase 2 (SG-3)
      </p>

      <CheckinModal
        open={open}
        onClose={() => setOpen(false)}
        source="sidebar"
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-Cr-text-subtle-v2">{label}</span>
      <span className="text-Cr-text-default-v2 font-mono">{value}</span>
    </div>
  );
}

function DemoButton({
  label,
  description,
  onClick,
  highlight,
}: {
  label: string;
  description: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-lg-v2 active:opacity-80 transition-opacity ${
        highlight
          ? 'bg-dreamy-checkin-cta-v2/20 border border-dreamy-checkin-cta-v2/40'
          : 'bg-Cr-Bg-surface-default-v2'
      }`}
    >
      <div className="text-sm font-semibold text-Cr-text-default-v2">{label}</div>
      <div className="text-xs text-Cr-text-subtle-v2 mt-1">{description}</div>
    </button>
  );
}
