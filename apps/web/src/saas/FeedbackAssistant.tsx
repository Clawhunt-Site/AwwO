// The feedback assistant in the bottom-left corner of every AwwO page, signed in or not (owner, 2026-11-09: 「在awwo站上
// 要放个AI助手，放在左下角，然后作为反馈bug内容，能够实时的反馈到support@clawhunt.store」). A person says what went
// wrong; the assistant (backend feedback.go, a platform model) asks for what an engineer would need and writes the
// report; one press sends it to the support inbox at once, with where they were, their browser, the site's build and
// what this page saw failing (feedbackDiagnostics.ts), and any screenshots. Without the assistant (it did not answer,
// or this site has none) the person's own words are sent; without the site's mail, their own mail client takes it.
//
// The conversation lives in the page and in this tab's sessionStorage, so moving to another page keeps it; nothing is
// sent anywhere until the person asks the assistant something or presses Send. The button keeps out of the controls a
// page holds in that corner (feedbackPlacement.ts).
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from 'react';
import { BotMessageSquare, Check, Copy, ImagePlus, LoaderCircle, Mail, RotateCcw, Send, X } from 'lucide-react';
import { useSaaSPreferences } from './preferences';
import { askFeedbackAssistant, FEEDBACK_FALLBACK_EMAIL, FEEDBACK_STORE, FeedbackError, feedbackMailto, feedbackStatus, feedbackText, sendFeedback,
  type FeedbackReport, type FeedbackStatus, type FeedbackTurn } from './feedbackApi';
import { feedbackContext } from './feedbackDiagnostics';
import { SHOT_LIMIT, shrinkScreenshot, type FeedbackShot } from './feedbackShots';
import { LAUNCHER_MARGIN, useLauncherPlacement } from './feedbackPlacement';
import { copyText } from './copyText';
import './feedback-assistant.css';

const STORE = FEEDBACK_STORE;
/** What the API takes of one conversation (feedback.go): messages, one message's length, all of them together. */
const MESSAGES = 16;
const MESSAGE_MAX = 2000;
const TEXT_MAX = 15000;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** `who`: whose conversation it is (an account's address, or "visitor"), once the site has said; another person's is
 *  dropped as soon as the site says who is here now. */
type Saved = { open: boolean; messages: FeedbackTurn[]; report: FeedbackReport | null; draft: string; contact: string; who?: string };
const EMPTY: Saved = { open: false, messages: [], report: null, draft: '', contact: '' };
const whoOf = (status: FeedbackStatus) => status.signedIn ? `account:${(status.email || '').toLowerCase()}` : 'visitor';

function isReport(value: unknown): value is FeedbackReport {
  const r = value as FeedbackReport | null;
  return !!r && typeof r === 'object' && typeof r.title === 'string' && !!r.title && typeof r.summary === 'string' && Array.isArray(r.steps)
    && r.steps.every(step => typeof step === 'string') && typeof r.expected === 'string' && typeof r.actual === 'string'
    && ['bug', 'feature', 'question', 'other'].includes(r.category) && ['low', 'medium', 'high', 'critical'].includes(r.severity);
}

/** This tab's conversation, as an earlier page of it left it; anything that does not hold is dropped. */
function readSaved(): Saved {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (!value || typeof value !== 'object') return EMPTY;
    const messages = Array.isArray(value.messages) ? value.messages.filter((m: FeedbackTurn) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.text === 'string').slice(-MESSAGES) : [];
    return { open: value.open === true, messages, report: isReport(value.report) ? value.report : null,
      draft: typeof value.draft === 'string' ? value.draft.slice(0, MESSAGE_MAX) : '', contact: typeof value.contact === 'string' ? value.contact.slice(0, 254) : '',
      ...(typeof value.who === 'string' ? { who: value.who.slice(0, 300) } : {}) };
  } catch { return EMPTY; }
}

/** The conversation as the API takes it: its latest messages, starting with one of the person's, within its sizes. */
function forServer(messages: FeedbackTurn[]): FeedbackTurn[] {
  const kept: FeedbackTurn[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < MESSAGES; i--) {
    const text = messages[i].text.slice(0, MESSAGE_MAX);
    if (total + text.length > TEXT_MAX) break;
    total += text.length;
    kept.unshift({ role: messages[i].role, text });
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

/** Where the person is, in a few words for the assistant. */
function pageLabel(signedIn: boolean | undefined, uiMode: string): string {
  const query = new URLSearchParams(window.location.search);
  const mode = uiMode === 'developer' ? 'developer mode' : 'simple mode';
  if (window.location.pathname === '/admin') return 'admin panel';
  if (query.get('canvas')) return `canvas page${query.get('view') === 'results' ? ', results view' : ''}, ${mode}`;
  if (query.get('invite')) return 'invitation page';
  if (signedIn === false) return 'sign-in page';
  const section = query.get('section');
  return `workspace home${section ? `, ${section.replace(/[^a-z-]/gi, '').slice(0, 30)} section` : ''}`;
}

export function FeedbackAssistant() {
  const { t, locale, uiMode } = useSaaSPreferences();
  const [saved] = useState(readSaved);
  const [open, setOpen] = useState(saved.open);
  const [messages, setMessages] = useState<FeedbackTurn[]>(saved.messages);
  const [report, setReport] = useState<FeedbackReport | null>(saved.report);
  const [draft, setDraft] = useState(saved.draft);
  const [contact, setContact] = useState(saved.contact);
  const [shots, setShots] = useState<FeedbackShot[]>([]);
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [who, setWho] = useState<string | undefined>(saved.who);
  const [busy, setBusy] = useState<'thinking' | 'sending' | null>(null);
  const [assistantDown, setAssistantDown] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; offerMail: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const turn = useRef<AbortController | null>(null);
  // The panel takes the focus when the person opens it, never when a page opens on it (a sign-in form keeps its own).
  const openedHere = useRef(false);
  // Whose conversation this is, as the site last said (the saved one's until it says again).
  const whoNow = useRef<string | undefined>(saved.who);
  const { place, covered } = useLauncherPlacement(launcher);
  const panelId = useId();
  const titleId = useId();

  // The conversation outlives a move to another page of this tab; a report once sent is not kept, so it is never sent twice.
  useEffect(() => {
    try {
      if (sent || (!open && !messages.length && !draft && !report && !contact)) sessionStorage.removeItem(STORE);
      else sessionStorage.setItem(STORE, JSON.stringify({ open, messages, report, draft, contact, ...(who ? { who } : {}) } satisfies Saved));
    } catch { /* storage full or off: the conversation lives in this page */ }
  }, [open, messages, report, draft, contact, sent, who]);

  // What the site can do here and who is here, read each time the panel opens (a sign-in or sign-out in between counts).
  // A conversation another person left in this tab is dropped before anything of it can be sent.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    feedbackStatus(controller.signal).then(value => {
      const now = whoOf(value);
      if (whoNow.current && whoNow.current !== now) {
        turn.current?.abort(); turn.current = null;
        setMessages([]); setReport(null); setDraft(''); setContact(''); setShots([]); setSent(null); setProblem(null); setBusy(null);
      }
      whoNow.current = now;
      setWho(now);
      setStatus(value);
    }, () => { /* the status stays as last read; sending says what went wrong */ });
    return () => controller.abort();
  }, [open]);

  useEffect(() => { if (open && openedHere.current) { openedHere.current = false; input.current?.focus({ preventScroll: true }); } }, [open]);
  useLayoutEffect(() => { const box = list.current; if (box) box.scrollTop = box.scrollHeight; }, [messages, busy, report, sent, open]);
  useEffect(() => () => turn.current?.abort(), []);

  const signedIn = status?.signedIn;
  const address = status?.supportEmail || FEEDBACK_FALLBACK_EMAIL;
  const said = messages.some(m => m.role === 'user' && m.text.trim());
  const assistantOn = !assistantDown && status?.assistant !== false;
  const launcherShown = place !== null && !covered;

  const close = () => {
    setOpen(false);
    if (launcherShown && document.activeElement instanceof HTMLElement && document.activeElement.closest('.awwo-feedback-panel')) launcher.current?.focus();
  };
  const restart = () => {
    turn.current?.abort(); turn.current = null;
    setMessages([]); setReport(null); setDraft(''); setShots([]); setSent(null); setProblem(null); setAssistantDown(false); setBusy(null);
    input.current?.focus();
  };

  const ask = async () => {
    const text = draft.trim().slice(0, MESSAGE_MAX);
    if (!text || busy) return;
    const next: FeedbackTurn[] = [...(sent ? [] : messages), { role: 'user', text }];
    if (sent) { setReport(null); setSent(null); }
    setMessages(next); setDraft(''); setProblem(null);
    if (!assistantOn) return;
    const controller = new AbortController();
    turn.current = controller;
    setBusy('thinking');
    try {
      const answer = await askFeedbackAssistant(forServer(next), locale, pageLabel(signedIn, uiMode), controller.signal);
      setMessages(current => [...current, { role: 'assistant', text: answer.reply }]);
      if (answer.ready && answer.report) setReport(answer.report);
    } catch {
      if (!controller.signal.aborted) setAssistantDown(true);
    } finally {
      if (turn.current === controller) { turn.current = null; setBusy(null); }
    }
  };

  const send = async () => {
    if (busy === 'sending') return;
    let conversation = messages;
    // Words still in the box go with the report: pressing Send means "send what I wrote".
    if (draft.trim()) { conversation = [...messages, { role: 'user', text: draft.trim().slice(0, MESSAGE_MAX) }]; setMessages(conversation); setDraft(''); }
    if (!conversation.some(m => m.role === 'user' && m.text.trim())) { input.current?.focus(); return; }
    const reply = signedIn ? '' : contact.trim();
    if (reply && !EMAIL.test(reply)) { setProblem({ text: t('联系邮箱的格式不对，改一下或者留空。', 'The contact email does not look right: fix it or leave it empty.'), offerMail: false }); return; }
    if (status && !status.available) {
      setProblem({ text: t('这里暂时不能直接发送。可以用你自己的邮箱发给我们，内容已经替你写好。', 'Reports cannot be sent from here right now. Send it from your own email instead; it is written for you.'), offerMail: true });
      return;
    }
    // An answer still coming is dropped, and it can no longer end the send's busy state when it unwinds.
    turn.current?.abort(); turn.current = null;
    setBusy('sending'); setProblem(null);
    try {
      const out = await sendFeedback({ messages: forServer(conversation), report, contact: reply, locale, context: feedbackContext(uiMode),
        attachments: shots.map(shot => ({ type: shot.type, data: shot.data })) });
      setSent(out.id); setShots([]);
    } catch (error) {
      const code = error instanceof FeedbackError ? error.code : '';
      const text = code === 'rate_limited' ? t('发送得太频繁了，过一会儿再试；着急的话可以直接发邮件给我们。', 'Too many reports in a short time: try again in a while, or email us if it is urgent.')
        : code === 'invalid_attachment' ? t('有张截图没法发送，删掉它再试一次。', 'One of the screenshots cannot be sent: remove it and try again.')
        : code === 'network' ? t('网络没有响应，报告还在这里，可以重试，或者用邮件发给我们。', 'The network did not answer. Your report is still here: try again, or email it to us.')
        : t('这次没有发出去，报告还在这里，可以重试，或者用邮件发给我们。', 'It was not sent. Your report is still here: try again, or email it to us.');
      setProblem({ text, offerMail: code !== 'invalid_attachment' });
    } finally {
      setBusy(null);
    }
  };

  const addShots = async (files: File[]) => {
    const room = SHOT_LIMIT - shots.length;
    const pictures = files.filter(file => file.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (!pictures.length) {
      if (files.length) setProblem({ text: room > 0 ? t('只能添加图片。', 'Only pictures can be added.') : t(`最多 ${SHOT_LIMIT} 张截图。`, `At most ${SHOT_LIMIT} screenshots.`), offerMail: false });
      return;
    }
    for (const file of pictures) {
      try {
        const shot = await shrinkScreenshot(file);
        setShots(current => current.length < SHOT_LIMIT ? [...current, shot] : current);
      } catch {
        setProblem({ text: t('这张图片读不了，换一张试试。', 'That picture could not be read: try another one.'), offerMail: false });
      }
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (!pasted.length) return;
    event.preventDefault();
    void addShots(pasted);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); }
  };
  const mailLink = () => feedbackMailto(address, t('AwwO 反馈', 'AwwO feedback') + (report ? `: ${report.title}` : ''), feedbackText(messages, report, feedbackContext(uiMode)));
  const copyReport = async () => {
    if (await copyText(feedbackText(messages, report, feedbackContext(uiMode)))) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
  };

  const anchor = place ?? { left: LAUNCHER_MARGIN, bottom: LAUNCHER_MARGIN };
  const docked = place?.width !== undefined;
  const launcherStyle = place ? { '--fb-left': `${place.left}px`, '--fb-bottom': `${place.bottom}px`, ...(docked ? { '--fb-width': `${place.width}px` } : {}) } as CSSProperties : undefined;
  // The panel opens over the button, 40px tall, with a gap.
  const panelStyle = { '--fb-left': `${anchor.left}px`, '--fb-bottom': `${anchor.bottom + 50}px` } as CSSProperties;
  const label = t('AI 反馈助手：报告问题或提建议', 'AI feedback assistant: report a problem or share an idea');
  const categories: Record<FeedbackReport['category'], string> = { bug: t('问题', 'Bug'), feature: t('建议', 'Idea'), question: t('疑问', 'Question'), other: t('其他', 'Other') };
  const severities: Record<FeedbackReport['severity'], string> = { low: t('轻微', 'Low'), medium: t('一般', 'Medium'), high: t('严重', 'High'), critical: t('紧急', 'Critical') };
  const starters = [t('运行失败或一直卡住', 'A run failed or hangs'), t('页面显示不对', 'Something looks wrong'), t('登录或账号问题', 'Sign-in or account'), t('我有个建议', 'I have an idea')];

  return <>
    <button ref={launcher} type="button" className={`awwo-feedback-launcher${open ? ' is-open' : ''}`} style={launcherStyle} data-hidden={launcherShown ? undefined : ''}
      data-docked={docked ? '' : undefined} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={label} title={label}
      onClick={() => { if (open) close(); else { openedHere.current = true; setOpen(true); } }}>
      <span className="awwo-feedback-launcher-mark" aria-hidden="true"><BotMessageSquare size={17} /></span>
      <span className="awwo-feedback-launcher-short">{t('反馈', 'Feedback')}</span>
      <span className="awwo-feedback-launcher-long">{t('AI 反馈助手', 'AI feedback')}<small>{t('报告问题或提建议', 'Report a problem')}</small></span>
    </button>
    {/* Hidden, not closed, while one of the app's own modal dialogs is open: the conversation waits under it. */}
    {open && <section id={panelId} className="awwo-feedback-panel" style={panelStyle} role="dialog" aria-modal="false" aria-labelledby={titleId} hidden={covered}
      lang={locale === 'zh' ? 'zh-CN' : 'en'} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); } }}>
      <header className="awwo-feedback-head">
        <span className="awwo-feedback-mark" aria-hidden="true"><BotMessageSquare size={18} /></span>
        <div><h2 id={titleId}>{t('AwwO 反馈助手', 'AwwO feedback assistant')}</h2><p>{t('AI 帮你整理问题，实时发给 AwwO 团队', 'AI writes it up; the team gets it at once')}</p></div>
        {(messages.length > 0 || sent) && <button type="button" className="awwo-feedback-icon" onClick={restart} disabled={busy === 'sending'} aria-label={t('重新开始', 'Start over')} title={t('重新开始', 'Start over')}><RotateCcw size={16} /></button>}
        <button type="button" className="awwo-feedback-icon" onClick={close} aria-label={t('关闭', 'Close')} title={t('关闭', 'Close')}><X size={17} /></button>
      </header>
      <div ref={list} className="awwo-feedback-thread" aria-live="polite">
        <p className="awwo-feedback-bubble is-assistant">{t('你好，我是 AwwO 的 AI 反馈助手。遇到报错、卡住，或者有建议？直接告诉我发生了什么，我帮你整理清楚，一键实时发给 AwwO 团队。',
          "Hi, I'm AwwO's AI feedback assistant. Hit an error, got stuck, or have an idea? Tell me what happened: I'll write it up and send it to the AwwO team in one click.")}</p>
        {!messages.length && !sent && <div className="awwo-feedback-starters">{starters.map(starter => <button type="button" key={starter}
          onClick={() => { setDraft(`${starter}${locale === 'zh' ? '：' : ': '}`); input.current?.focus(); }}>{starter}</button>)}</div>}
        {messages.map((m, i) => <p key={i} className={`awwo-feedback-bubble is-${m.role}`}>{m.text}</p>)}
        {busy === 'thinking' && <p className="awwo-feedback-bubble is-assistant is-typing" role="status" aria-label={t('助手正在回复', 'The assistant is replying')}><i /><i /><i /></p>}
        {assistantDown && !sent && <p className="awwo-feedback-note">{t('AI 助手暂时没有回应。你写的内容可以直接发送，团队一样能收到。', "The AI assistant isn't answering right now. You can send what you wrote as it is; the team gets it all the same.")}</p>}
        {report && !sent && <article className="awwo-feedback-report" aria-label={t('待发送的报告', 'Report to send')}>
          <span className="awwo-feedback-eyebrow">{t('待发送的报告 · AI 已整理', 'Report to send · written up by AI')}</span>
          <h3>{report.title}</h3>
          <div className="awwo-feedback-tags"><span>{categories[report.category]}</span><span className={`is-${report.severity}`}>{severities[report.severity]}</span></div>
          {report.summary && <p>{report.summary}</p>}
          {report.steps.length > 0 && <ol>{report.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
          {report.expected && <p><strong>{t('期望：', 'Expected: ')}</strong>{report.expected}</p>}
          {report.actual && <p><strong>{t('实际：', 'Actual: ')}</strong>{report.actual}</p>}
          <small>{t('不准确的话，在下面接着补充，我会重新整理。', 'Not quite right? Add to it below and I will write it up again.')}</small>
        </article>}
        {sent && <article className="awwo-feedback-sent" role="status">
          <span className="awwo-feedback-sent-mark" aria-hidden="true"><Check size={18} /></span>
          <div>
            <h3>{t('已发送给 AwwO 团队', 'Sent to the AwwO team')}</h3>
            <p>{t('编号', 'Reference')} <strong>{sent}</strong></p>
            <p>{signedIn && status?.email ? t(`我们会尽快查看，回复会发到 ${status.email}。`, `We'll look into it soon and reply to ${status.email}.`)
              : contact.trim() ? t(`我们会尽快查看，回复会发到 ${contact.trim()}。`, `We'll look into it soon and reply to ${contact.trim()}.`)
              : t('我们会尽快查看。你没有留邮箱，所以我们没法直接回复你。', "We'll look into it soon. You left no email, so we can't reply to you directly.")}</p>
            <button type="button" className="awwo-feedback-secondary" onClick={restart}>{t('再反馈一个', 'Report something else')}</button>
          </div>
        </article>}
      </div>
      {!sent && <footer className="awwo-feedback-foot">
        {problem && <div className="awwo-feedback-problem" role="alert"><p>{problem.text}</p>
          {problem.offerMail && <div className="awwo-feedback-problem-actions">
            <a href={mailLink()}><Mail size={14} aria-hidden="true" />{t(`用邮件发送到 ${address}`, `Email it to ${address}`)}</a>
            <button type="button" onClick={() => void copyReport()}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? t('已复制', 'Copied') : t('复制报告', 'Copy the report')}</button>
          </div>}
        </div>}
        {shots.length > 0 && <ul className="awwo-feedback-shots" aria-label={t('截图', 'Screenshots')}>{shots.map((shot, i) => <li key={shot.id}>
          <img src={shot.preview} alt={t(`截图 ${i + 1}`, `Screenshot ${i + 1}`)} />
          <button type="button" onClick={() => setShots(current => current.filter(item => item.id !== shot.id))} aria-label={t(`移除截图 ${i + 1}`, `Remove screenshot ${i + 1}`)}><X size={12} /></button>
        </li>)}</ul>}
        {signedIn === false && (said || draft.trim()) && <label className="awwo-feedback-contact"><span>{t('联系邮箱（选填，方便我们回复你）', 'Your email (optional, so we can reply)')}</span>
          <input type="email" value={contact} maxLength={254} autoComplete="email" placeholder="you@example.com" onChange={event => setContact(event.target.value)} /></label>}
        <div className="awwo-feedback-composer">
          <textarea ref={input} value={draft} maxLength={MESSAGE_MAX} rows={2} onChange={event => setDraft(event.target.value)} onKeyDown={onKey} onPaste={onPaste}
            placeholder={messages.length ? t('补充细节，或者直接发送…', 'Add details, or send it…') : t('描述你遇到的问题，可以粘贴截图…', 'Describe what happened; you can paste a screenshot…')}
            aria-label={t('写给反馈助手', 'Message the feedback assistant')} disabled={busy === 'sending'} />
          <div className="awwo-feedback-tools">
            <button type="button" className="awwo-feedback-icon" onClick={() => picker.current?.click()} disabled={shots.length >= SHOT_LIMIT || busy === 'sending'}
              aria-label={t('添加截图', 'Add a screenshot')} title={t(`添加截图（最多 ${SHOT_LIMIT} 张）`, `Add a screenshot (up to ${SHOT_LIMIT})`)}><ImagePlus size={17} /></button>
            <input ref={picker} type="file" accept="image/*" multiple hidden onChange={event => { void addShots([...(event.target.files ?? [])]); event.target.value = ''; }} />
            {assistantOn && <button type="button" className="awwo-feedback-ask" onClick={() => void ask()} disabled={!draft.trim() || busy !== null}
              aria-label={t('发给助手', 'Send to the assistant')} title={t('发给助手（Enter）', 'Send to the assistant (Enter)')}><Send size={16} /></button>}
          </div>
        </div>
        <button type="button" className={`awwo-feedback-send${report || !assistantOn ? ' is-primary' : ''}`} onClick={() => void send()} disabled={busy === 'sending' || (!said && !draft.trim())}>
          {busy === 'sending' ? <><LoaderCircle size={16} className="awwo-feedback-spin" aria-hidden="true" />{t('正在发送…', 'Sending…')}</>
            : report ? t('发送给 AwwO 团队', 'Send to the AwwO team') : t('不用整理，直接发送给团队', 'Send it to the team as it is')}
        </button>
        <p className="awwo-feedback-privacy">{signedIn
          ? t('发送时会附上你的账号、当前页面地址、浏览器信息和这个页面最近的报错，只用于排查问题。', 'Sending includes your account, this page’s address, your browser and the errors this page met lately, for fixing the problem only.')
          : t('发送时会附上当前页面地址、浏览器信息和这个页面最近的报错，只用于排查问题。', 'Sending includes this page’s address, your browser and the errors this page met lately, for fixing the problem only.')}</p>
      </footer>}
    </section>}
  </>;
}
