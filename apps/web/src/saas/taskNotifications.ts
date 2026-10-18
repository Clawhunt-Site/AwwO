// 设置 → 通用 → 任务提醒: when a task this page was watching ends while the reader is away from the page (another tab,
// another window, minimised), a browser notification and/or one short chime, as the account chose. A task already
// over when the page opened never notifies; nothing is sent anywhere, the page itself does it.
import { currentAccountPreferences } from './accountPreferences';

export type FinishedTask = { title: string; body: string; failed?: boolean };

const away = () => typeof document !== 'undefined' && (document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus()));

export const browserNotificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** Asks the browser for permission; true when notifications may be shown. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!browserNotificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

let audio: AudioContext | null = null;
/** One soft two-note chime, about half a second, faded in and out so it never clicks. */
export function playChime() {
  const Context = typeof window !== 'undefined' ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!Context) return;
  try {
    audio ||= new Context();
    // A context made while the page was in the background can start suspended under the autoplay rules.
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const start = audio.currentTime + 0.02;
    [[660, 0], [880, 0.16]].forEach(([frequency, offset]) => {
      const tone = audio!.createOscillator(), gain = audio!.createGain();
      tone.type = 'sine'; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(0.18, start + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.4);
      tone.connect(gain).connect(audio!.destination);
      tone.start(start + offset); tone.stop(start + offset + 0.42);
    });
  } catch { /* No sound: the task's result is on the page either way. */ }
}

export function notifyTaskFinished(task: FinishedTask) {
  const settings = currentAccountPreferences()?.notifications;
  if (!settings || (!settings.browser && !settings.sound) || !away()) return;
  if (settings.sound) playChime();
  if (settings.browser && browserNotificationsSupported() && Notification.permission === 'granted') {
    try {
      const shown = new Notification(task.title, { body: task.body, tag: 'awwo-task' });
      shown.onclick = () => { window.focus(); shown.close(); };
    } catch { /* Some browsers only allow notifications from a service worker; the page still has the result. */ }
  }
}
