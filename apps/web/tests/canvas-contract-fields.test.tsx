import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContractFields } from '../src/canvas/ContractFields';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import type { ContractField } from '../src/canvas/nodeContracts';

afterEach(cleanup);
function Editor({ initial, readOnly = false, valuesFirst = false }: { initial: ContractField[]; readOnly?: boolean; valuesFirst?: boolean }) {
  const [fields, setFields] = useState(initial);
  return <><ContractFields valuesFirst={valuesFirst} fields={fields} onChange={setFields} readOnly={readOnly} label="输入" /><output data-testid="raw">{JSON.stringify(fields)}</output></>;
}
const field = (over: Partial<ContractField> = {}): ContractField => ({ id: 'brief', label: '需求', type: 'markdown', required: true, value: '# 登录页\n\n**可访问**的表单。', ...over });

describe('node contract field editor', () => {
  it.each(['text', 'markdown', 'html', 'number', 'boolean', 'file'] as const)('describes the %s editor without treating help or placeholder as its value', type => {
    const hinted = field({ type, value: '', help: '只填写已确认的内容。', placeholder: '角色专属填写提示' });
    render(<Editor initial={[hinted]} />);
    const editor = screen.getByLabelText('需求的值');
    expect(editor).toHaveValue('');
    expect(editor).toHaveAccessibleDescription('只填写已确认的内容。');
    const help = screen.getByText('只填写已确认的内容。');
    expect(editor).toHaveAttribute('aria-describedby', help.id);
    if (type === 'boolean') expect(screen.getByRole('option', { name: '角色专属填写提示' })).toHaveAttribute('value', '');
    else expect(editor).toHaveAttribute('placeholder', '角色专属填写提示');
    expect(screen.getByRole('alert')).toHaveTextContent('必填');
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0]).toEqual(hinted);
  });

  it('lets the operator require an HTML document while keeping its source inert', () => {
    render(<Editor initial={[field({ type: 'text', value: '' })]} />);
    fireEvent.change(screen.getByLabelText('需求的类型'), { target: { value: 'html' } });
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].type).toBe('html');
    fireEvent.change(screen.getByLabelText('需求的值'), { target: { value: '<script>alert(1)</script>' } });
    expect(screen.getByRole('alert')).toHaveTextContent('完整 HTML');
    expect(document.querySelector('script')).toBeNull();
  });

  it('keeps a wired field read-only while using its local guidance', () => {
    const local = field({ value: '', help: '核对来自上游的数据模型。', placeholder: '等待模型字段' });
    render(<ContractFields fields={[local]} resolvedFields={[field({ value: '# 上游数据模型' })]}
      sources={{ brief: '数据治理' }} label="输入" onChange={() => {}} />);
    expect(screen.getByLabelText('需求的值')).toBeDisabled();
    expect(screen.getByLabelText('需求的值')).toHaveValue('# 上游数据模型');
    expect(screen.getByLabelText('需求的值')).toHaveAttribute('placeholder', '等待模型字段');
    expect(screen.getByLabelText('需求的值')).toHaveAccessibleDescription('核对来自上游的数据模型。');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows validated upstream input without overwriting the stored local fallback or reporting a false required error', () => {
    const local = field({ value: '' });
    render(<ContractFields fields={[local]} resolvedFields={[{ ...local, value: '# 上游需求' }]}
      sources={{ brief: '数据治理' }} label="输入" onChange={() => {}} />);
    expect(screen.getByLabelText('需求的值')).toHaveValue('# 上游需求');
    expect(screen.getByLabelText('需求的值')).toBeDisabled();
    expect(screen.getByLabelText('字段 1 名称')).not.toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(canvasText('zh', 'contract.sourceResolved', { source: '数据治理' }))).toBeTruthy();
    expect(local.value).toBe('');
  });

  it('says a required wired input is waiting for its upstream, not missing', () => {
    render(<ContractFields fields={[field({ value: '' })]} sources={{ brief: '数据治理' }} label="输入" onChange={() => {}} />);
    expect(screen.getByText(canvasText('zh', 'contract.sourceWaiting', { source: '数据治理' }))).toBeTruthy();
    expect(screen.getByLabelText('需求的值')).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still names a missing local input beside a waiting wired one, in the reader’s language', () => {
    const wired = field({ id: 'recorder', label: 'The recorder', type: 'file', value: '' });
    const local = field({ id: 'notes', label: 'Notes', type: 'text', value: '' });
    render(<LocaleProvider locale="en"><ContractFields valuesFirst fields={[wired, local]} sources={{ recorder: 'Turn recorder' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(canvasText('en', 'contract.sourceWaiting', { source: 'Turn recorder' }))).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(/^“Notes” is required\.$/);
  });

  it('names a wired value that arrived but does not fit, beside the output it came from', () => {
    // prepareNodeConversation's values once every upstream delivered: here one left the wired output out.
    const wired = field({ id: 'notes', label: 'Notes', value: '' });
    render(<LocaleProvider locale="en"><ContractFields valuesFirst fields={[wired]} resolvedFields={[wired]} sources={{ notes: 'Researcher' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(canvasText('en', 'contract.sourceResolved', { source: 'Researcher' }))).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(/^“Notes” is required\.$/);
  });

  it.each([
    ['en', 'No image file from “Hero” yet. If it makes none, this node goes on without it. Disconnect the wire to enter a value manually.', 'Key art value', 'Preview Key art'],
    ['zh', '“Hero”还没有生成出图像文件：若最终没有生成，本节点照常进行，不用它；断开连线后可手动填写。', 'Key art的值', '预览Key art'],
  ] as const)('says in %s that a wired media node made no file, instead of showing the note its agent reads', (locale, note, value, preview) => {
    // prepareNodeConversation's values: the picture's wire carries the agent's note (mediaMissingText), marked as such. A
    // value typed in before the field was wired stays stored, and is not shown either.
    const agentNote = '「Hero」这次没有生成出图片文件，没有可以引用的路径：网页里不要引用它的任何文件，也不要编造文件名，用不依赖它的设计完成。';
    const art = field({ id: 'art', label: 'Key art', value: '# Typed before the wire' });
    const { container } = render(<LocaleProvider locale={locale}><ContractFields valuesFirst fields={[art]} resolvedFields={[{ ...art, value: agentNote }]}
      sources={{ art: 'Hero' }} mediaMissing={{ art: 'image' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(note)).toBeVisible();
    expect(note).toBe(canvasText(locale, 'contract.sourceMediaMissing', { source: 'Hero', kind: canvasText(locale, 'media.kindImage') }));
    expect(screen.queryByText(canvasText(locale, 'contract.sourceResolved', { source: 'Hero' }))).toBeNull();
    expect(screen.getByLabelText(value)).toHaveValue('');
    expect(screen.getByLabelText(value)).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: preview }));
    expect(screen.getByText(canvasText(locale, 'contract.noContent'))).toBeVisible();
    expect(container.textContent).not.toContain('没有可以引用的路径');
    if (locale === 'en') expect(container.textContent).not.toMatch(/\p{Script=Han}/u);
  });

  it('says nothing of media on a field that is not wired, and keeps its value', () => {
    const local = field({ id: 'art', label: 'Key art', value: '# Our own art direction' });
    render(<LocaleProvider locale="en"><ContractFields valuesFirst fields={[local]} resolvedFields={[local]} mediaMissing={{ art: 'image' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByLabelText('Key art value')).toHaveValue('# Our own art direction');
    expect(screen.queryByText(/^No image file/)).toBeNull();
  });

  it('names what the media upstream makes', () => {
    const fields = (['video', 'model3d', 'audio'] as const).map(kind => field({ id: kind, label: kind, value: '' }));
    render(<LocaleProvider locale="en"><ContractFields valuesFirst fields={fields} resolvedFields={fields.map(item => ({ ...item, value: 'note' }))}
      sources={{ video: 'Clip', model3d: 'Ship', audio: 'Theme' }} mediaMissing={{ video: 'video', model3d: 'model3d', audio: 'audio' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(/^No video file from “Clip” yet\. If it makes none/)).toBeVisible();
    expect(screen.getByText(/^No 3D model file from “Ship” yet\. If it makes none/)).toBeVisible();
    expect(screen.getByText(/^No audio file from “Theme” yet\. If it makes none/)).toBeVisible();
  });

  it.each([
    ['en', 'No image file from “Hero” yet. Disconnect the wire to enter a value manually.', /^“Key art” must be a complete HTML document/],
    ['zh', '“Hero”还没有生成出图像文件；断开连线后可手动填写。', /^「Key art」需要包含 html、head 和 body/],
  ] as const)('promises nothing in %s on an HTML input, which refuses the note, and lets the alert say why', (locale, note, alert) => {
    const page = field({ id: 'art', label: 'Key art', type: 'html', value: '' });
    render(<LocaleProvider locale={locale}><ContractFields valuesFirst fields={[page]} resolvedFields={[{ ...page, value: '「Hero」这次没有生成出图片文件…' }]}
      sources={{ art: 'Hero' }} mediaMissing={{ art: 'image' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(note)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(alert);
  });

  it('keeps its promise on a media input when another field is what is missing', () => {
    // The page's own brief is emptied: the alert names it, and the picture's input still does not hold the page back.
    const brief = field({ id: 'brief', label: 'Brief', value: '' });
    const art = field({ id: 'art', label: 'Key art', value: '' });
    render(<LocaleProvider locale="en"><ContractFields valuesFirst fields={[brief, art]} resolvedFields={[brief, { ...art, value: '「Hero」这次没有生成出图片文件…' }]}
      sources={{ art: 'Hero' }} mediaMissing={{ art: 'image' }} label="Input" onChange={() => {}} /></LocaleProvider>);
    expect(screen.getByText(canvasText('en', 'contract.sourceMediaMissing', { source: 'Hero', kind: 'image' }))).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/^“Brief” is required\.$/);
  });

  it('says what a value lacks in the reader’s language', () => {
    render(<LocaleProvider locale="en"><Editor initial={[field({ label: 'Count', type: 'number', value: 'many' })]} /></LocaleProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(/^“Count” must be a valid number\.$/);
  });

  it('previews Markdown without replacing the original serialized text', () => {
    render(<Editor initial={[field()]} />);
    fireEvent.click(screen.getByRole('button', { name: '预览需求' }));
    expect(screen.getByRole('heading', { name: '登录页' })).toBeTruthy();
    expect(screen.getByText('可访问').tagName).toBe('STRONG');
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].value).toBe(field().value);
    fireEvent.click(screen.getByRole('button', { name: '编辑需求' }));
    expect((screen.getByLabelText('需求的值') as HTMLTextAreaElement).value).toBe(field().value);
  });

  it('formats selected text and keeps the rest of the Markdown intact', () => {
    render(<Editor initial={[field({ value: '保留原文' })]} />);
    const value = screen.getByLabelText('需求的值') as HTMLTextAreaElement;
    value.focus(); value.setSelectionRange(2, 4);
    fireEvent.click(screen.getByRole('button', { name: '需求加粗' }));
    expect(JSON.parse(screen.getByTestId('raw').textContent!)[0].value).toBe('保留**原文**');
  });

  it('adds and removes fields with independent ids', () => {
    render(<Editor initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    const fields = JSON.parse(screen.getByTestId('raw').textContent!);
    expect(fields[0].id).not.toBe(fields[1].id);
    fireEvent.click(screen.getByRole('button', { name: '删除字段 1' }));
    expect(JSON.parse(screen.getByTestId('raw').textContent!)).toHaveLength(1);
  });

  it('adds a field under an id no field has, where one the list already holds took the next', () => {
    // An editor's ids start again with each page load, so a field saved by an earlier page can hold the next one.
    let put: (fields: ContractField[]) => void = () => {};
    function Host() {
      const [fields, setFields] = useState<ContractField[]>([]);
      put = setFields;
      return <><ContractFields fields={fields} onChange={setFields} label="输入" /><output data-testid="raw">{JSON.stringify(fields)}</output></>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    const [first] = JSON.parse(screen.getByTestId('raw').textContent!) as ContractField[];
    const next = first.id.replace(/\d+$/, count => String(Number(count) + 1));
    act(() => put([first, { ...first, id: next, label: '已保存的字段' }]));
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    const ids = (JSON.parse(screen.getByTestId('raw').textContent!) as ContractField[]).map(field => field.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('shows required validation and represents a file as a reference', () => {
    render(<Editor initial={[field({ type: 'file', value: '' })]} />);
    expect(screen.getByRole('alert').textContent).toMatch(/需求|必填/);
    expect(screen.getByText('填写文件路径或链接；不会上传文件。')).toBeTruthy();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('allows preview but prevents every data mutation in read-only mode', () => {
    render(<Editor initial={[field()]} readOnly />);
    expect((screen.getByLabelText('字段 1 名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除需求' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '添加字段' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '预览需求' }));
    expect(screen.getByRole('heading', { name: '登录页' })).toBeTruthy();
  });
});


it('keeps task entry focused on values without changing its contract until customization is requested', () => {
  const initial = field();
  render(<Editor initial={[initial]} valuesFirst />);
  expect(screen.queryByLabelText('字段 1 名称')).toBeNull();
  expect(screen.queryByRole('button', { name: '添加字段' })).toBeNull();
  fireEvent.change(screen.getByLabelText('需求的值'), { target: { value: '新的任务' } });
  const value = { ...initial, value: '新的任务' };
  expect(JSON.parse(screen.getByTestId('raw').textContent!)).toEqual([value]);
  fireEvent.click(screen.getByRole('button', { name: '编辑字段结构' }));
  expect(screen.getByLabelText('字段 1 名称')).toHaveValue('需求');
  expect(screen.getByLabelText('需求的类型')).toHaveValue('markdown');
  expect(JSON.parse(screen.getByTestId('raw').textContent!)).toEqual([value]);
  fireEvent.click(screen.getByRole('button', { name: '完成结构编辑' }));
  expect(screen.queryByLabelText('字段 1 名称')).toBeNull();
  expect(screen.getByLabelText('需求的值')).toHaveValue('新的任务');
});

it('keeps wired values and reader access locked in the simplified input view', () => {
  render(<ContractFields valuesFirst fields={[field()]} sources={{ brief: '上游' }} label="输入" readOnly onChange={() => { throw new Error('must not write'); }} />);
  expect(screen.getByLabelText('需求的值')).toBeDisabled();
  expect(screen.queryByRole('button', { name: '编辑字段结构' })).toBeNull();
});

it('previews a wired delivery as inert as the delivery itself: no navigation away, no image requests', () => {
  const wired = field({ id: 'from_design', label: '设计', value: '' });
  const delivered = '[规格](artifacts/spec.md) · [参考](https://example.com/guide) · ![示意图](https://example.com/pixel.png)';
  render(<ContractFields fields={[wired]} resolvedFields={[{ ...wired, value: delivered }]} sources={{ from_design: '设计节点' }} label="输入" onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '预览设计' }));
  const preview = screen.getByLabelText(canvasText('zh', 'contract.previewName', { name: '设计' }));
  expect(preview.querySelector('img')).toBeNull();
  expect(preview).toHaveTextContent('示意图');
  expect(screen.getByRole('link', { name: '参考' })).toHaveAttribute('target', '_blank');
  expect(screen.getByText('规格').closest('a')).toBeNull();
  expect(screen.getByText('规格')).toHaveAttribute('title', 'artifacts/spec.md');
});
