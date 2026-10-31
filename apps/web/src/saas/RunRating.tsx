// A person's 👍 / 👎 for a run's result (canvas_lessons.go rateRun): what the canvas's lessons, and later the lessons a
// model writes, learn from. Pressing the chosen one again takes the rating back. Readers see it, members rate.
import { useEffect, useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { saasErrorMessage } from './api';
import { rateRun, readRunRating, type RunRating as Rating } from './lessonsApi';
import { useSaaSPreferences } from './preferences';
import './canvas-lessons.css';

export function RunRating({ tenantId, runId, canRate }: { tenantId: string; runId: string; canRate: boolean }) {
  const { t, locale } = useSaaSPreferences();
  const [rating, setRating] = useState<Rating>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What an answer that comes back is for: the run shown, and its latest read or vote. One for another run, or a read
  // older than a vote, is dropped.
  const latest = useRef({ run: '', version: 0 });
  useEffect(() => {
    const run = `${tenantId}/${runId}`;
    const version = latest.current.version + 1;
    latest.current = { run, version };
    const controller = new AbortController();
    setRating(0); setError(null); setBusy(false);
    // A rating that cannot be read says so, instead of looking unrated; a vote still sets one.
    readRunRating(tenantId, runId, controller.signal).then(value => {
      if (latest.current.run === run && latest.current.version === version) setRating(value);
    }, cause => {
      if (!controller.signal.aborted && latest.current.run === run && latest.current.version === version) setError(cause);
    });
    return () => controller.abort();
  }, [tenantId, runId]);
  const rate = async (score: 1 | -1) => {
    if (busy || !canRate) return;
    const run = `${tenantId}/${runId}`;
    const version = latest.current.version + 1;
    latest.current = { run, version };
    const current = () => latest.current.run === run && latest.current.version === version;
    setBusy(true); setError(null);
    try {
      const value = await rateRun(tenantId, runId, rating === score ? 0 : score);
      if (current()) setRating(value);
    } catch (cause) { if (current()) setError(cause); }
    finally { if (current()) setBusy(false); }
  };
  return <span className="awwo-run-rating" role="group" aria-label={t('这次的结果', 'This result')}>
    <button type="button" aria-pressed={rating === 1} aria-label={t('好', 'Good')} title={t('好：AwwO 记下这次的做法可行', 'Good: AwwO notes that this worked')} disabled={busy || !canRate} onClick={() => void rate(1)}><ThumbsUp size={12} aria-hidden="true" /></button>
    <button type="button" aria-pressed={rating === -1} aria-label={t('不好', 'Not good')} title={t('不好：AwwO 记下这次的结果不理想', 'Not good: AwwO notes that this result fell short')} disabled={busy || !canRate} onClick={() => void rate(-1)}><ThumbsDown size={12} aria-hidden="true" /></button>
    {error !== null && <span role="alert">{saasErrorMessage(error, locale)}</span>}
  </span>;
}
