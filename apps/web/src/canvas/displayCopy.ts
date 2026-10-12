// The 预览展示 node's words, in both languages. Kept beside the node (not in the shared catalogue) so the feature is
// one self-contained set of files.
import { useCallback } from 'react';
import type { UiLocale } from '../locale';
import { useCanvasI18n } from './i18n';

const EN = {
  'display.label': 'Preview',
  'display.add': 'Preview display',
  'display.addHint': 'Shows, live, what a component or the whole canvas made',
  'display.addSection': 'Display',
  'display.showCanvas': 'Preview display: see everything the canvas made, live',
  'display.showNode': 'Show in a preview display',
  'display.source': 'What it shows',
  'display.sourceCanvas': 'Whole canvas · all results',
  'display.sourceMissing': 'A component no longer on the canvas',
  'display.all': 'All',
  'display.final': 'Result',
  'display.only': 'Show alone',
  'display.back': 'All results',
  'display.zoomIn': 'Zoom in',
  'display.zoomOut': 'Zoom out',
  'display.zoomReset': 'Actual size ({percent}%). Ctrl or ⌘ + scroll zooms too',
  'display.reload': 'Reload',
  'display.fullscreen': 'Full screen',
  'display.exitFullscreen': 'Exit full screen',
  'display.delete': 'Delete this preview display',
  'display.resize': 'Resize the preview display',
  'display.frame': 'Preview display: {title}',
  'display.files': 'Files of {title}',
  'display.emptyCanvas': 'Nothing delivered yet. Run the components (or chat with one) and what they make shows here, live.',
  'display.emptyNode': '"{title}" has delivered nothing yet. Chat with it or run it, and its result shows here.',
  'display.running': '"{title}" is working on it…',
  'display.runningShort': 'Working',
  'display.redoing': 'Being redone; this is the previous result',
  'display.missingNode': 'The component this showed is no longer on the canvas. Choose another above.',
  'display.count': '{count} results',
  'display.farAway': 'Zoom the canvas in to see it live',
  'display.unreadable': 'This file could not be read here.',
  'display.statePartial': 'Unfinished',
  'display.stateManual': 'Adopted by hand',
  'display.stateCase': 'Case recording',
  'display.tooMany': 'A canvas holds at most {count} preview displays.',
} as const;

export type DisplayTextKey = keyof typeof EN;

const ZH: Record<DisplayTextKey, string> = {
  'display.label': '预览展示',
  'display.add': '预览展示',
  'display.addHint': '实时展示一个组件或整个画布的成果',
  'display.addSection': '展示',
  'display.showCanvas': '预览展示：实时查看整个画布的全部成果',
  'display.showNode': '在预览展示中查看',
  'display.source': '展示内容',
  'display.sourceCanvas': '整个画布 · 全部成果',
  'display.sourceMissing': '已不在画布上的组件',
  'display.all': '全部',
  'display.final': '最终成果',
  'display.only': '单独展示',
  'display.back': '全部成果',
  'display.zoomIn': '放大',
  'display.zoomOut': '缩小',
  'display.zoomReset': '原始大小（当前 {percent}%）；按住 Ctrl 或 ⌘ 滚动也能缩放',
  'display.reload': '重新载入',
  'display.fullscreen': '全屏',
  'display.exitFullscreen': '退出全屏',
  'display.delete': '删除这个预览展示',
  'display.resize': '调整预览展示的大小',
  'display.frame': '预览展示：{title}',
  'display.files': '「{title}」的文件',
  'display.emptyCanvas': '画布还没有交付物。运行组件（或和组件对话）后，它们做出的成果会实时显示在这里。',
  'display.emptyNode': '「{title}」还没有交付物。和它对话或运行它，成果会显示在这里。',
  'display.running': '「{title}」正在制作…',
  'display.runningShort': '制作中',
  'display.redoing': '正在重做，先显示上一版',
  'display.missingNode': '它展示的组件已不在画布上，请在上方换一个。',
  'display.count': '{count} 个成果',
  'display.farAway': '放大画布即可实时查看',
  'display.unreadable': '这个文件无法在这里读取。',
  'display.statePartial': '未完成',
  'display.stateManual': '手动采用',
  'display.stateCase': '案例记录',
  'display.tooMany': '一张画布最多放 {count} 个预览展示。',
};

const CATALOG: Record<UiLocale, Record<DisplayTextKey, string>> = { en: EN, zh: ZH };

export function displayText(locale: UiLocale, key: DisplayTextKey, values: Record<string, string | number> = {}): string {
  return CATALOG[locale][key].replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(values, name) ? String(values[name]) : token);
}

export type DisplayTranslate = (key: DisplayTextKey, values?: Record<string, string | number>) => string;

export function useDisplayText(): DisplayTranslate {
  const { locale } = useCanvasI18n();
  return useCallback((key, values) => displayText(locale, key, values), [locale]);
}
