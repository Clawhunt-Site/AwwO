/** Public, curated snapshots contain no tenant, canvas, session or private run identifiers. */
export type OfficialRunNodeStatus = 'done' | 'failed' | 'blocked' | 'canceled' | 'cached';
export interface OfficialGeneratedRecord {
  readonly model: string;
  readonly capturedOn: string;
  readonly completed: number;
  readonly total: number;
  readonly artifactNodeId: string;
  readonly reused?: number;
  readonly originalSHA256?: string;
  readonly sourceSHA256: string;
  readonly nodes: Readonly<Record<string, OfficialRunNodeStatus>>;
  readonly note: Readonly<{ zh: string; en: string }>;
  readonly verification: Readonly<{ zh: string; en: string }>;
}
export const OFFICIAL_GENERATED_RECORDS: Readonly<Partial<Record<string, OfficialGeneratedRecord>>> = {
  'orbit-game': {
    model: 'claude-sonnet-5', capturedOn: '2026-10-01', completed: 6, total: 6, artifactNodeId: 'build',
    sourceSHA256: 'd8eb2462bf598cbf2af5d6163ac40a466ef3fa6f35d5fddc167623f3b78618ca',
    originalSHA256: '3fcf2394d35933a4eb27252a19f28e2a33b154265fd4755a6333bb2a64e154a7',
    nodes: { rules: 'done', mechanics: 'done', art: 'done', build: 'done', qa: 'done', release: 'done' },
    note: { zh: '本次工作流 6/6 节点完成。右侧为模型生成游戏；官方验收仅修正重置按钮遮挡，游戏逻辑保持原文。', en: 'All 6/6 workflow nodes completed. This is the model-generated game; official QA only corrected an overlapping reset button. Game logic is unchanged.' },
    verification: { zh: '已实测 18 步获胜、能量耗尽失败、撞墙不扣能、首次采集奖励、终态锁定、重置和局部键盘操作。', en: 'Browser checked an 18-move win, energy exhaustion, no wall penalties, one-time collection rewards, end-state locking, reset and board-scoped keyboard input.' },
  },
  'grid-balance': {
    model: 'claude-sonnet-5', capturedOn: '2026-10-01', completed: 2, total: 4, reused: 5, artifactNodeId: 'repair',
    sourceSHA256: '387a6063e1dd856a6a8af2a69e296d456f578a593fa32c5b20dc3c245bcba388',
    originalSHA256: '2388674c6ccb4ccad8c443390cb4505c46e88448438f043317ce104604abff3a',
    nodes: { scope: 'cached', data: 'cached', model: 'cached', build: 'cached', checks: 'cached', repair: 'done', recheck: 'done', deliver: 'failed', guide: 'blocked' },
    note: { zh: '本轮续跑完成 2/4 节点，沿用 5 个上游结果；最终交付未通过 HTML 完整性校验，指南被阻断。右侧基于修复节点产物，官方验收修订了套利供电、动态校验、时窗提示与控件标签。', en: 'This continuation completed 2/4 nodes and reused five upstream results. Final delivery failed HTML completeness validation, blocking the guide. The result uses the repair output with official QA fixes for arbitrage load serving, dynamic checks, time-window feedback and control labels.' },
    verification: { zh: '已实测 7 组情景，每组核对 24 小时电量守恒、储能边界、非负缺口与停电时零购电；支持实时参数与策略比较。', en: 'Browser checked seven scenarios with 24 hourly rows each: energy conservation, battery bounds, non-negative unmet load and zero grid imports during outages; live controls and strategy comparison work.' },
  },
  'model-lab': {
    model: 'claude-sonnet-5', capturedOn: '2026-10-01', completed: 4, total: 6, artifactNodeId: 'build',
    sourceSHA256: 'ac7c7b312a454a51f5509845e4442185e15b2c51c89516cfa6a46e2d5fe404a7',
    originalSHA256: 'ad4f67cd27232d900e4fd983a896e404dbb06d04ae2392f7775632ff193d3fdb',
    nodes: { dataset: 'done', trainer: 'done', metrics: 'done', build: 'done', check: 'failed', card: 'blocked' },
    note: { zh: '训练台已生成；模型数值复核因额度不足失败，模型卡被阻断。官方验收修订了零噪声参数、预测输入校验、重置清理与重训定时器，保留原始模型运行状态。', en: 'The trainer was generated; model numerical review failed due to quota, blocking the model card. Official QA fixed zero-noise handling, prediction input checks, reset cleanup and retraining timers. Original run statuses are preserved.' },
    verification: { zh: '已实测训练、重训、中断、预测与重置；零噪声 200 轮的训练/验证损失 0.4602/0.4479，与独立数值重算一致。', en: 'Browser checked training, repeated runs, interruption, prediction and reset. The zero-noise 200-epoch train/validation losses, 0.4602/0.4479, match an independent numerical calculation.' },
  },
  'interaction-page': {
    model: 'claude-sonnet-5', capturedOn: '2026-10-01', completed: 5, total: 6, artifactNodeId: 'build',
    sourceSHA256: '6fd8e7c47418a0225ddc013201eb187bdeb19a1f96b29ef8ca3714d104ac4b6b',
    nodes: { brief: 'done', copy: 'done', states: 'done', build: 'done', review: 'done', handoff: 'failed' },
    note: { zh: '构建与审查已完成；最后的复用指南因模型额度不足停止。右侧为构建节点原始产物，整图未全部完成。', en: 'Build and review completed; the final reuse guide failed due to model quota. The right pane shows the original build output. The full workflow did not complete.' },
    verification: { zh: '已在浏览器实测三套餐 × 1/30 人 × 月/年付共 12 组金额、人数边界与方案摘要。', en: 'Browser checked: 12 combinations of three plans, 1/30 seats and monthly/yearly billing, plus seat boundaries and proposal summaries.' },
  },
};
