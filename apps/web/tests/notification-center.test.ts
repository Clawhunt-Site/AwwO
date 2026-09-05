import { describe, expect, it } from 'vitest';
import { formatNotificationTime, inferToastTone, isBackgroundStatusText } from '../src/App';

describe('inferToastTone', () => {
  it('flags clear failures/refusals as error', () => {
    for (const text of [
      'media status failed: Error: /api/media/status returned 502',
      'control token rotation failed: boom',
      'fusion action blocked',
      'media generation requires a template',
      '刷新失败: returned 503',
      '能力目录加载失败',
    ]) {
      expect(inferToastTone(text)).toBe('error');
    }
  });

  it('treats non-failure confirmations and hints as neutral info, never green success', () => {
    for (const text of [
      'Conversation archived',
      'Conversation ID copied: session_8c842c90314d',
      'control token rotated',
      'Capabilities refreshed',
    ]) {
      expect(inferToastTone(text)).toBe('info');
    }
  });
});

describe('isBackgroundStatusText', () => {
  it('suppresses diagnostic probe noise', () => {
    for (const text of [
      'desktop runtime failed: x',
      'plugin registry failed: x',
      'backend probe failed: x',
      'eval probe failed: x',
      // Degraded-mode catalog/workshop load failures: the persistent state is the
      // in-context banner, so these must not also fire an auto-dismiss toast.
      'capability catalog failed; using legacy registry: returned 503',
      'capability workshop failed: returned 503',
    ]) {
      expect(isBackgroundStatusText(text)).toBe(true);
    }
  });

  it('does not suppress user-facing transient messages', () => {
    for (const text of [
      'media status failed: Error: returned 502',
      'Conversation archived',
      'Capability refresh failed: returned 503',
    ]) {
      expect(isBackgroundStatusText(text)).toBe(false);
    }
  });
});

describe('formatNotificationTime', () => {
  const now = Date.now();

  it('renders just-now under 45s', () => {
    expect(formatNotificationTime(now, 'en')).toBe('just now');
    expect(formatNotificationTime(now, 'zh')).toBe('刚刚');
  });

  it('renders minutes/hours/days with locale', () => {
    expect(formatNotificationTime(now - 120_000, 'en')).toBe('2m ago');
    expect(formatNotificationTime(now - 120_000, 'zh')).toBe('2 分钟前');
    expect(formatNotificationTime(now - 2 * 3600_000, 'en')).toBe('2h ago');
    expect(formatNotificationTime(now - 2 * 3600_000, 'zh')).toBe('2 小时前');
    expect(formatNotificationTime(now - 3 * 86_400_000, 'en')).toBe('3d ago');
    expect(formatNotificationTime(now - 3 * 86_400_000, 'zh')).toBe('3 天前');
  });
});
