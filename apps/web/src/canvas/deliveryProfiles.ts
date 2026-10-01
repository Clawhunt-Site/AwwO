import type { UiLocale } from '../locale';
import type { ContractField, NodeContract } from './nodeContracts';

/** Delivery intent is independent of the node's persona or selected model. */
export type DeliveryProfileId = 'web' | 'game' | 'model3d' | 'report' | 'agent' | 'project';
export interface DeliveryProfile { id: DeliveryProfileId; label: string; description: string; field: ContractField; companions?: ContractField[] }

export function deliveryProfiles(locale: UiLocale = 'zh'): DeliveryProfile[] {
  const en = locale === 'en';
  const items: Array<[DeliveryProfileId, string, string, ContractField['type'], string]> = en ? [
    ['web', 'Website', 'A complete webpage with its real interface and interactions.', 'html', 'Deliver a complete self-contained HTML document, including its styles and any required inline interaction code. Supply actual source, not a URL, screenshot or implementation plan. State which browser checks actually ran in the handoff.'],
    ['game', 'Game', 'A playable game with controls, feedback and restart.', 'html', 'Deliver the complete self-contained HTML game, including inline styles and JavaScript, real controls, game state, feedback and restart. Do not substitute a design document or static mockup. Report only tests that actually ran.'],
    ['model3d', '3D model', 'The actual model file and a description of its dimensions and materials.', 'file', 'Deliver an actual .gltf, .glb or .obj model file, with required companion assets or a real archive containing them. Include units, dimensions, materials and opening instructions in the handoff. With a text-only runtime, a self-contained glTF JSON or OBJ source can be delivered; never claim a binary export, render or tool check that did not occur.'],
    ['report', 'Report', 'A complete report with sources, findings and limitations.', 'markdown', 'Deliver the report itself in Markdown with its findings, evidence, sources and explicit limitations. Do not replace the report with an outline or a list of files that do not exist.'],
    ['agent', 'Agent project', 'Agent source, setup instructions and actual validation evidence.', 'file', 'Deliver actual Agent source files or a real project archive. Include entry points, configuration examples without secrets, README setup/start instructions, and test commands with their actual results. A JSON file listing proposed paths is not a completed project. Never claim an archive, installed tool, executed command or working integration without actual evidence.'],
    ['project', 'Source project', 'Project source, README and reproducible start and test instructions.', 'file', 'Deliver actual source files or a real project archive, including required assets, README, start instructions, dependency/configuration examples without secrets, and tests with actual evidence. A plan or JSON list of proposed files is not the project. If the runtime cannot create, run or package it, state that limit instead of inventing a downloadable archive or successful checks.'],
  ] : [
    ['web', '网页', '完整页面、真实界面与交互。', 'html', '交付完整、自包含的 HTML 文档，包含样式与所需的内联交互代码。提供实际源码，不用链接、截图或实现计划代替网页；在交接说明中记录实际执行的浏览器检查。'],
    ['game', '游戏', '可以操作、有反馈、可以重新开始。', 'html', '交付完整、自包含的 HTML 游戏，包含内联样式、JavaScript、操作方式、游戏状态、反馈与重新开始。不能用设计说明或静态效果图代替游戏；只记录实际执行的测试。'],
    ['model3d', '3D 模型', '模型文件，以及尺寸、材质和打开方式。', 'file', '交付真实的 .gltf、.glb 或 .obj 模型文件，连同必要素材或包含它们的真实归档；在交接说明中注明单位、尺寸、材质和打开方式。仅有文本能力时可以交付自包含 glTF JSON 或 OBJ 源码，不能声称生成了未实际导出的二进制文件、渲染图或工具检查。'],
    ['report', '报告', '有来源、结论和适用范围的完整报告。', 'markdown', '交付 Markdown 报告正文，包含结论、证据、来源与明确的限制。不能用提纲或不存在的文件清单代替完整报告。'],
    ['agent', 'Agent 开发', '源码、配置、启动方式与真实验证记录。', 'file', '交付实际的 Agent 源码文件或真实工程归档，包含入口、无密钥的配置示例、README 安装与启动说明、测试命令及实际结果。列出计划路径的 JSON 清单不等于完成的项目；不能声称生成了未创建的归档、安装了不可用的工具或完成了未执行的联调。'],
    ['project', '工程项目', '项目源码、README、启动与测试说明。', 'file', '交付实际源码文件或真实工程归档，包含必要素材、README、启动说明、无密钥的依赖与配置示例、测试及真实证据。计划或拟建文件的 JSON 清单不等于项目。运行时不能创建、运行或打包时明确说明限制，不虚构可下载的归档或通过的检查。'],
  ];
  return items.map(([id, label, description, type, help]) => ({ id, label, description,
    field: { id: `delivery_${id}`, label, type, required: true, value: '', help },
    ...(id === 'model3d' ? { companions: [{ id: 'delivery_model3d_preview', label: en ? '3D preview (optional)' : '3D 预览（可选）', type: 'html' as const, required: false, value: '',
      help: en ? 'Optionally include a complete self-contained HTML canvas/WebGL viewer with inline model data matching the actual delivered model. The viewer is a companion, not a substitute for the 3D file. Do not require external libraries or URLs.'
        : '可附完整、自包含的 HTML canvas/WebGL 预览，内联的数据必须对应实际交付的模型。预览不能代替真实 3D 文件，不依赖外部库或链接。' }] } : {}),
    ...(id === 'report' ? { companions: [{ id: 'delivery_report_pdf', label: en ? 'PDF file (optional)' : 'PDF 文件（可选）', type: 'file' as const, required: false, value: '',
      help: en ? 'Attach the actual PDF only if the available runtime created it. If PDF export is unavailable, omit this optional field and retain the complete Markdown report; do not invent a PDF path or rename text as PDF.'
        : '只有可用运行时实际生成 PDF 时才附该文件；无法导出时省略此可选字段并保留完整 Markdown 报告，不虚构 PDF 路径或把文本改名为 PDF。' }] } : {}),
  }));
}

/** Add a requirement without replacing an existing contract or creating output bytes. */
export function appendDeliveryProfile(contract: NodeContract, id: DeliveryProfileId, locale: UiLocale = 'zh'): NodeContract {
  const profile = deliveryProfiles(locale).find(item => item.id === id);
  if (!profile) throw new Error('Unknown delivery profile');
  const outputs = [...contract.outputs];
  for (const next of [profile.field, ...profile.companions ?? []]) {
    if (outputs.some(field => (field.id === next.id || new RegExp(`^${next.id}_[0-9]+$`).test(field.id))
      && field.type === next.type && field.help === next.help)) continue;
    if (outputs.length >= 32 || (next.type === 'file' && outputs.filter(field => field.type === 'file').length >= 8)) {
      throw new Error(locale === 'zh' ? '每个节点最多 32 个交付字段，其中最多 8 个文件；请先整理已有交付。'
        : 'A node supports at most 32 output fields, including 8 files. Consolidate existing deliverables first.');
    }
    const ids = new Set(outputs.map(field => field.id));
    let fieldId = next.id;
    for (let suffix = 2; ids.has(fieldId); suffix++) fieldId = `${next.id}_${suffix}`;
    outputs.push({ ...next, id: fieldId });
  }
  return outputs.length === contract.outputs.length ? contract : { ...contract, outputs };
}

export function deliveryCapabilityNotice(locale: UiLocale): string {
  return locale === 'zh' ? '交付要求不会自动启用终端、浏览器或制作工具；实际执行以节点可用能力为准。'
    : 'Delivery requirements do not enable a terminal, browser or creation tools. Execution depends on the node’s available capabilities.';
}
