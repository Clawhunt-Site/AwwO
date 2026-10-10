import { expect, it } from 'vitest';
import { assistantCostNote } from '../src/canvas/assistantCost';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';

const zh: CanvasTranslate = (key, values) => canvasText('zh', key, values);
const en: CanvasTranslate = (key, values) => canvasText('en', key, values);

// Owner decision 2026-10-10: the assistant's canvas changes no longer use the free daily calls, up to 20 a day.
it('says how many free canvas changes are left today when the server reports them', () => {
  expect(assistantCostNote(zh, true, true, { limit: 20, used: 3 }))
    .toBe('改画布每天前 20 次免费，不占今天的次数（今天还剩 17 次），之后每次约 1 次；直接执行任务最多 16 次。问「现在缺什么」「下一步做什么」不用次数。');
  expect(assistantCostNote(zh, true, false, { limit: 20, used: 25 })).toContain('今天还剩 0 次');
  expect(assistantCostNote(en, true, false, { limit: 20, used: 20 })).toBe('Changing the canvas is free for the first 20 times a day (0 left today), then about 1 of today’s calls each. Asking “what’s missing?” or “what’s next?” uses none.');
});

it('keeps the general wording without a report, and says nothing where calls are not counted', () => {
  expect(assistantCostNote(zh, true, true, null)).toBe(canvasText('zh', 'assistant.costNoteUnified'));
  expect(assistantCostNote(zh, true, false, { limit: 0, used: 0 })).toBe(canvasText('zh', 'assistant.costNotePlan'));
  expect(assistantCostNote(zh, false, true, { limit: 20, used: 1 })).toBeUndefined();
});
