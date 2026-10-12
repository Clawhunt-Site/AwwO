// The review findings a rework wrote into an Agent's task requirements, shown on the Agent itself (2026-10-12: in
// 普通用户模式 the node has no settings, so nobody could see what the Agent had been told).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { ReworkFindingsNote } from '../src/canvas/ReworkFindingsNote';
import { reworkFindings, reworkRequirements } from '../src/canvas/reviewVerdict';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';

const MARKERS = (['zh', 'en'] as const).map(locale => canvasText(locale, 'assistant.reworkMarker'));
const marker = (locale: 'zh' | 'en', node: string) => canvasText(locale, 'assistant.reworkMarker', { node });
const header = (locale: 'zh' | 'en') => canvasText(locale, 'assistant.reworkHeader', { verdict: locale === 'zh' ? '不通过' : 'Fail' });
const FINDINGS = '### 问题与返工清单\n问题：线索列表调用 /leads，契约为 /api/v1/leads\n修复建议：按接口契约统一路径与响应字段';

function reworked(frame: unknown): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'frontend', title: '心理咨询小程序前端开发', taskFrame: frame } as SessionNode;
}

afterEach(cleanup);

describe('reworkFindings', () => {
  it('reads what a rework wrote, in either language, and nothing else', () => {
    const zh = reworkRequirements({ version: 1, source: 'manual', constraints: ['使用 TypeScript'], acceptanceCriteria: ['页面可运行'] },
      marker('zh', '小程序产品交付验收'), header('zh'), FINDINGS);
    const both = reworkRequirements(zh, marker('en', 'Final review'), header('en'), '### Issues\nThe login page calls /login.');
    expect(reworkFindings(both, MARKERS)).toEqual([
      { reviewer: '小程序产品交付验收', text: `${header('zh')}\n${FINDINGS}` },
      { reviewer: 'Final review', text: `${header('en')}\n### Issues\nThe login page calls /login.` },
    ]);
    // A rework from the same review again replaces its requirement, so it is still read once.
    expect(reworkFindings(reworkRequirements(both, marker('zh', '小程序产品交付验收'), header('zh'), '### 问题\n还剩一处'), MARKERS)
      .map(item => item.reviewer)).toEqual(['Final review', '小程序产品交付验收']);
  });

  it('reads nothing from requirements without a rework, or ones this page cannot read', () => {
    expect(reworkFindings({ version: 1, source: 'manual', constraints: ['【验收返工】没有节点名', '普通约束'], acceptanceCriteria: [] }, MARKERS)).toEqual([]);
    expect(reworkFindings({ version: 2, constraints: [`${marker('zh', '验收')}结论`] }, MARKERS)).toEqual([]);
    expect(reworkFindings(undefined, MARKERS)).toEqual([]);
  });
});

describe('ReworkFindingsNote', () => {
  const frame = reworkRequirements(undefined, marker('zh', '小程序产品交付验收'), header('zh'), FINDINGS);

  it('says which review the Agent carries, and opens to exactly what it is told', () => {
    render(<CanvasUiModeProvider mode="simple"><ReworkFindingsNote node={reworked(frame)} /></CanvasUiModeProvider>);
    const note = screen.getByRole('region', { name: '这个节点的验收意见' });
    const toggle = screen.getByRole('button', { name: /带着「小程序产品交付验收」的验收意见/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(note).not.toHaveTextContent('契约为 /api/v1/leads');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(note).toHaveTextContent('上次验收结论：不通过。请按下面的验收意见修改交付');
    expect(screen.getByRole('heading', { name: '问题与返工清单' })).toBeVisible();
    expect(note).toHaveTextContent('问题：线索列表调用 /leads，契约为 /api/v1/leads');
    // Without the settings panel, the note says how to change it.
    expect(note).toHaveTextContent('要修改或删除，切到开发者模式，在节点配置里改。');
    fireEvent.click(toggle);
    expect(note).not.toHaveTextContent('契约为 /api/v1/leads');
  });

  it('points a developer at the settings, and reads in English', () => {
    render(<LocaleProvider locale="en"><CanvasUiModeProvider mode="developer"><ReworkFindingsNote node={reworked(frame)} /></CanvasUiModeProvider></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Carries the findings of “小程序产品交付验收”/ }));
    expect(screen.getByRole('region', { name: 'Review findings for this node' }))
      .toHaveTextContent('Change or remove it under Task requirements in the node’s settings.');
  });

  it('is not there for an Agent without a rework', () => {
    const { container } = render(<ReworkFindingsNote node={reworked({ version: 1, source: 'manual', constraints: ['使用 TypeScript'], acceptanceCriteria: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
