import { expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { buildNodeMessage, preflightGraph, validateNodeOutput } from '../src/canvas/runGraph';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';

function guidedNode(): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    title: '接口实现',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Backend' },
    contract: { version: 1, inputs: [
      { id: 'brief', label: '业务需求', type: 'markdown', required: true, value: '实现工作区邀请',
        help: '以实际业务约束为准。', placeholder: '例如：团队邀请流程' },
      { id: 'constraints', label: '补充约束', type: 'markdown', required: false, value: '',
        help: '未提供的约束请标为待确认。', placeholder: '此处只是输入示例' },
    ], outputs: [
      { id: 'api', label: '接口契约', type: 'markdown', required: true, value: '',
        help: '逐条列出方法、路径和错误响应。', placeholder: '## 接口\n## 鉴权\n## 错误响应' },
      { id: 'verification', label: '验证记录', type: 'markdown', required: true, value: '',
        help: '区分已执行检查与尚未验证的项目。', placeholder: '## 已验证\n## 待验证' },
    ] },
  };
}

it('carries field guidance and output structure into the execution prompt without mutating values', () => {
  const node = guidedNode();
  const before = structuredClone(node);
  const message = buildNodeMessage(node, []);
  expect(message).toContain('以实际业务约束为准。');
  expect(message).toContain('实现工作区邀请');
  expect(message).toContain('未提供的约束请标为待确认。');
  expect(message).toContain('（未填写）');
  expect(message).not.toContain('此处只是输入示例');
  expect(message).toContain('逐条列出方法、路径和错误响应。');
  expect(message).toContain('## 接口\n## 鉴权\n## 错误响应');
  expect(message).toContain('区分已执行检查与尚未验证的项目。');
  expect(message).toContain('## 已验证\n## 待验证');
  expect(message).toContain('最终输出必须是以字段 ID 为键的 JSON 对象');
  expect(node).toEqual(before);
});

it('never treats help or placeholders as required input values or completed output', () => {
  const node = guidedNode();
  node.contract!.inputs[0].value = '';
  expect(preflightGraph([node], [])).toContain('业务需求');
  expect(() => buildNodeMessage(node, [])).toThrow('业务需求');
  expect(prepareNodeConversation(node).error).toContain('业务需求');
  expect(validateNodeOutput(node, '{}')).toHaveLength(2);
  expect(node.lastOutput).toBeUndefined();
  expect(node.contract!.outputs.every(field => field.value === '')).toBe(true);
});

it('uses the same guidance for conversation context and keeps untouched schemas concise', () => {
  const node = guidedNode();
  const context = prepareNodeConversation(node);
  expect(context.error).toBeUndefined();
  expect(context.messagePrefix).toContain('逐条列出方法、路径和错误响应。');
  expect(context.messagePrefix).toContain('## 已验证\n## 待验证');
  expect(context.inputs?.find(field => field.id === 'constraints')?.value).toBe('');
  node.contract!.inputs = node.contract!.inputs.map(({ help, placeholder, ...field }) => field);
  node.contract!.outputs = node.contract!.outputs.map(({ help, placeholder, ...field }) => field);
  const plain = buildNodeMessage(node, []);
  expect(plain).not.toContain('字段说明');
  expect(plain).not.toContain('结构参考');
  expect(plain).toContain('实现工作区邀请');
});
