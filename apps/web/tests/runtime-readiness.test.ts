import { describe, expect, it } from 'vitest';
import { runtimeReadiness } from '../src/settings/runtimeReadiness';

describe('runtime readiness presentation', () => {
  it('does not call a present executable ready or unavailable', () => {
    expect(runtimeReadiness({ available: true, readiness: 'installed' }, 'zh')).toEqual({
      label: '已安装 · 待验证', detail: '已检测到本地 CLI；登录状态和执行能力尚未验证。',
    });
  });
  it('distinguishes no selection, missing CLI, and registration only', () => {
    expect(runtimeReadiness(null, 'zh').label).toBe('请选择 Agent');
    expect(runtimeReadiness({ available: false, readiness: 'missing' }, 'en').label).toBe('Not installed');
    expect(runtimeReadiness({ available: false, readiness: 'unverified' }, 'en').label).toBe('Unverified');
    expect(runtimeReadiness({ available: true }, 'en').label).toBe('Unverified');
  });
});
