import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContractFields } from '../src/canvas/ContractFields';
import { canvasText } from '../src/canvas/i18n';
import type { ContractField } from '../src/canvas/nodeContracts';

afterEach(cleanup);
function Editor({ initial, readOnly = false }: { initial: ContractField[]; readOnly?: boolean }) {
  const [fields, setFields] = useState(initial);
  return <><ContractFields fields={fields} onChange={setFields} readOnly={readOnly} label="输入" /><output data-testid="raw">{JSON.stringify(fields)}</output></>;
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
