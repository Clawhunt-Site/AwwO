import { useCallback, useEffect, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GitBranch,
  type LucideIcon,
  MessageSquareText,
  Puzzle,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react';

// A large, centered welcome modal that teaches a new user what ClawHunt is and
// how to drive it. Presentation-layer only: it adds no kernel semantics, it just
// renders a branded multi-step walkthrough over a dimmed backdrop. Completion /
// skip is reported through `onClose`; the host persists it in the kernel config.

export type TourLocale = 'zh' | 'en';

type Feature = { icon: LucideIcon; text: string };
type StepCopy = { title: string; body: string; features: Feature[] };

type TourStep = {
  key: string;
  icon: LucideIcon;
  zhLabel: string;
  enLabel: string;
  zh: StepCopy;
  en: StepCopy;
};

const TOUR_STEPS: TourStep[] = [
  {
    key: 'welcome',
    icon: Sparkles,
    zhLabel: '欢迎',
    enLabel: 'Welcome',
    zh: {
      title: '欢迎来到 ClawHunt',
      body: '一句话说清你想要什么，ClawHunt 就能帮你把它真正交付出来——从规划、执行到验收，端到端完成。',
      features: [
        { icon: Zap, text: '描述目标，而不是一步步下指令' },
        { icon: ShieldCheck, text: '关键操作有治理与人工审批兜底' },
        { icon: Rocket, text: '本地、桌面、云端同一套能力' },
      ],
    },
    en: {
      title: 'Welcome to ClawHunt',
      body: 'Describe what you want in one line and ClawHunt delivers it end to end — planning, execution and verification, all the way through.',
      features: [
        { icon: Zap, text: 'Describe a goal instead of micro-managing steps' },
        { icon: ShieldCheck, text: 'Governance and human approval guard key actions' },
        { icon: Rocket, text: 'One capability set across local, desktop and cloud' },
      ],
    },
  },
  {
    key: 'chat',
    icon: MessageSquareText,
    zhLabel: '从对话开始',
    enLabel: 'Start a chat',
    zh: {
      title: '从一句话开始',
      body: '在底部输入框写下你的目标或任务，回车发送。简单问题直接对话，复杂交付直接描述任务即可，ClawHunt 会带你进入可验收的任务流。',
      features: [
        { icon: MessageSquareText, text: '回车发送，Shift + 回车换行' },
        { icon: Sparkles, text: '随时「新建会话」从干净上下文开始' },
        { icon: Zap, text: '历史对话与项目都在左侧栏随手可达' },
      ],
    },
    en: {
      title: 'Start with one sentence',
      body: 'Type your goal in the composer and press Enter. Chat for quick questions, or just describe a complex task to open a verifiable task flow.',
      features: [
        { icon: MessageSquareText, text: 'Enter to send, Shift + Enter for a new line' },
        { icon: Sparkles, text: 'Start a fresh chat anytime for a clean context' },
        { icon: Zap, text: 'History and projects live in the left sidebar' },
      ],
    },
  },
  {
    key: 'capabilities',
    icon: Puzzle,
    zhLabel: '能力与团队',
    enLabel: 'Capabilities & team',
    zh: {
      title: '装备能力，组建团队',
      body: '在「能力工坊」安装插件、技能与公司模板；在「Agent 组」里组建你的 agent 团队、分派工单、协同完成复杂交付。',
      features: [
        { icon: Puzzle, text: '能力工坊：插件 / 技能 / 公司模板' },
        { icon: Users, text: 'Agent 组：组队、派单、组织视图' },
        { icon: GitBranch, text: '能力先进内核，所有表层共用同一份' },
      ],
    },
    en: {
      title: 'Equip capabilities, build a team',
      body: 'Install plugins, skills and company templates in the Capability Workshop; assemble your agent team and assign issues in the Team workspace.',
      features: [
        { icon: Puzzle, text: 'Workshop: plugins / skills / company templates' },
        { icon: Users, text: 'Team: staffing, issues and the org view' },
        { icon: GitBranch, text: 'Capabilities live in the kernel, shared by every surface' },
      ],
    },
  },
  {
    key: 'governance',
    icon: ShieldCheck,
    zhLabel: '治理与交付',
    enLabel: 'Governance',
    zh: {
      title: '放心地把事情交出去',
      body: '扫描、支付这类高风险意图默认 fail-closed，需要人工审批；交付完成后你能看到证据与验收结论，全程可控可追溯。',
      features: [
        { icon: ShieldCheck, text: '高风险操作默认拦截 + 人工审批' },
        { icon: Check, text: '交付带证据与验收结论' },
        { icon: Zap, text: '实时事件流，过程透明可见' },
      ],
    },
    en: {
      title: 'Hand work off with confidence',
      body: 'Risky intents like scanning or payment are fail-closed and need human approval. Every delivery comes with evidence and a verification verdict.',
      features: [
        { icon: ShieldCheck, text: 'Risky actions are blocked pending human approval' },
        { icon: Check, text: 'Deliveries ship with evidence and a verdict' },
        { icon: Zap, text: 'A live event stream keeps the process transparent' },
      ],
    },
  },
  {
    key: 'ready',
    icon: Rocket,
    zhLabel: '开始使用',
    enLabel: 'Get started',
    zh: {
      title: '准备就绪，开始吧',
      body: '现在去底部输入框写下你的第一个目标试试。需要时随时从右下角账号菜单里「重新查看引导」。',
      features: [
        { icon: MessageSquareText, text: '写下第一个目标，回车发送' },
        { icon: Sparkles, text: '账号菜单可随时重新查看本引导' },
      ],
    },
    en: {
      title: "You're all set",
      body: 'Write your first goal in the composer below. You can replay this walkthrough anytime from the account menu.',
      features: [
        { icon: MessageSquareText, text: 'Write your first goal and press Enter' },
        { icon: Sparkles, text: 'Replay this tour anytime from the account menu' },
      ],
    },
  },
];

export type OnboardingTourProps = {
  open: boolean;
  locale: TourLocale;
  onClose: (completed: boolean) => void;
};

export function OnboardingTour({ open, locale, onClose }: OnboardingTourProps): JSX.Element | null {
  const [index, setIndex] = useState(0);

  const total = TOUR_STEPS.length;
  const step = TOUR_STEPS[index];
  const isFirst = index === 0;
  const isLast = index === total - 1;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const goNext = useCallback(() => {
    if (isLast) {
      onClose(true);
      return;
    }
    setIndex((current) => Math.min(current + 1, total - 1));
  }, [isLast, onClose, total]);

  const goBack = useCallback(() => setIndex((current) => Math.max(current - 1, 0)), []);
  const skip = useCallback(() => onClose(false), [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        skip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!isFirst) goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, skip, goNext, goBack, isFirst]);

  if (!open || !step) return null;

  const copy = locale === 'zh' ? step.zh : step.en;
  const txt = {
    skip: locale === 'zh' ? '跳过引导' : 'Skip tour',
    close: locale === 'zh' ? '关闭' : 'Close',
    back: locale === 'zh' ? '上一步' : 'Back',
    next: locale === 'zh' ? '下一步' : 'Next',
    done: locale === 'zh' ? '开始使用' : 'Get started',
    tagline: locale === 'zh' ? '端到端交付代理' : 'End-to-end delivery agent',
    stepOf: locale === 'zh' ? `第 ${index + 1} / ${total} 步` : `Step ${index + 1} of ${total}`,
  };

  return createPortal(
    <div className="onboarding-tour" role="dialog" aria-modal="true" aria-label={copy.title}>
      <div className="onboarding-backdrop" onClick={skip} aria-hidden="true" />
      <div className="onboarding-modal" onClick={(event) => event.stopPropagation()}>
        {/* Brand / navigation rail */}
        <aside className="onboarding-hero">
          <div className="onboarding-hero-orb onboarding-hero-orb-a" aria-hidden="true" />
          <div className="onboarding-hero-orb onboarding-hero-orb-b" aria-hidden="true" />
          <div className="onboarding-brand">
            <span className="onboarding-logo-tile">
              <img src="/superclaw-icon.png" alt="ClawHunt" />
            </span>
            <div className="onboarding-brand-copy">
              <strong>ClawHunt</strong>
              <span>{txt.tagline}</span>
            </div>
          </div>
          <ol className="onboarding-stepper" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <li
                  key={s.key}
                  className={`onboarding-stepper-item ${i === index ? 'is-active' : ''} ${
                    i < index ? 'is-done' : ''
                  }`}
                >
                  <span className="onboarding-stepper-dot">
                    {i < index ? <Check size={13} /> : <Icon size={14} />}
                  </span>
                  <span className="onboarding-stepper-label">
                    {locale === 'zh' ? s.zhLabel : s.enLabel}
                  </span>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* Step content */}
        <section className="onboarding-pane">
          <button className="onboarding-close" type="button" onClick={skip} aria-label={txt.close}>
            <X size={18} />
          </button>
          <div className="onboarding-pane-body" key={step.key}>
            <span className="onboarding-kicker">{txt.stepOf}</span>
            <h2 className="onboarding-title">{copy.title}</h2>
            <p className="onboarding-body">{copy.body}</p>
            <ul className="onboarding-features">
              {copy.features.map((feature, i) => {
                const FeatureIcon = feature.icon;
                return (
                  <li key={i} className="onboarding-feature">
                    <span className="onboarding-feature-icon" aria-hidden="true">
                      <FeatureIcon size={16} />
                    </span>
                    <span>{feature.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <footer className="onboarding-footer">
            <div className="onboarding-progress" aria-hidden="true">
              {TOUR_STEPS.map((s, i) => (
                <span
                  key={s.key}
                  className={`onboarding-progress-dot ${i === index ? 'is-active' : ''} ${
                    i < index ? 'is-done' : ''
                  }`}
                />
              ))}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-skip" type="button" onClick={skip}>
                {txt.skip}
              </button>
              {!isFirst ? (
                <button className="onboarding-secondary" type="button" onClick={goBack}>
                  <ArrowLeft size={16} />
                  {txt.back}
                </button>
              ) : null}
              <button className="onboarding-primary" type="button" onClick={goNext}>
                {isLast ? txt.done : txt.next}
                {isLast ? <Check size={16} /> : <ArrowRight size={16} />}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>,
    document.body,
  );
}

export default OnboardingTour;
