import {
  Box,
  Clipboard,
  FileText,
  Image as ImageIcon,
  Link2,
  ListVideo,
  Music,
  Paintbrush,
  Plus,
  Search,
  Sparkles,
  Upload,
  Video,
  Workflow,
} from 'lucide-react';

export const CANVASPRO_ENTRY = '/ai-canvaspro/index.html';
export const CANVASPRO_BRIDGE_SRC = '/ai-canvaspro/studio-bridge.js';
export const BRIDGE_REQUEST = 'aicanvas-studio:request';
export const BRIDGE_RESPONSE = 'aicanvas-studio:response';
export const BRIDGE_READY = 'aicanvas-studio:ready';
export const BRIDGE_AUTOSAVE = 'aicanvas-studio:autosave';
export const BRIDGE_AGENT_PANEL = 'aicanvas-studio:agent-panel';
export const GENERATION_AUTO_SYNC_INTERVAL_MS = 7000;
export const GENERATION_AUTO_SYNC_MIN_INTERVAL_MS = 6000;

export type QuickCreateKind = 'image' | 'video' | 'note';
export type QuickCreateAction = 'node' | 'flow' | 'storyboard' | 'variants' | 'organize';
export type AssistantActionKind = 'summary' | 'references' | 'gaps' | 'next' | 'directions';
export type AssistantExecutionMode = 'manual' | 'auto';
export type GenerationOutputContinuationAction = 'video' | 'variants' | 'reference';
export type GenerationTaskRerunAction = 'same' | 'model';
export type SelectedContextActionKind = 'image' | 'video' | 'reference' | 'variants' | 'flow';
export type AddMenuAction =
  | 'text'
  | 'image'
  | 'video'
  | 'audio-draft'
  | 'world-draft'
  | 'playlist-draft'
  | 'image-editor-draft'
  | 'upload';

export type AddMenuItem = {
  action: AddMenuAction;
  description: string;
  id: string;
  label: string;
};

export type AddMenuGroup = {
  id: string;
  items: AddMenuItem[];
  label: string;
};

export type CreateNodeOptions = {
  source?: 'selected';
};

export type CreateFlowOptions = {
  source?: 'selected';
};

export type QuickCreateCommand = {
  action?: QuickCreateAction;
  aliases: string[];
  command: string;
  description: string;
  kind?: QuickCreateKind;
  label: string;
  source?: 'selected';
};

export const QUICK_CREATE_COMMANDS: QuickCreateCommand[] = [
  {
    action: 'node',
    aliases: ['image', 'img', 'i', '图像', '图片'],
    command: 'image',
    description: 'AI image node',
    kind: 'image',
    label: '图像',
  },
  {
    action: 'node',
    aliases: ['video', 'vid', 'v', '视频'],
    command: 'video',
    description: 'AI video node',
    kind: 'video',
    label: '视频',
  },
  {
    action: 'node',
    aliases: ['note', 'text', 'txt', 'n', '文字', '文本', '笔记', '便签', '参考'],
    command: 'note',
    description: 'Canvas text reference node',
    kind: 'note',
    label: '文本',
  },
  {
    action: 'node',
    aliases: ['cite', 'mention', 'refnote', '@', '引用', '引用参考', '参考引用'],
    command: 'cite',
    description: 'Canvas text reference from selected content',
    kind: 'note',
    label: '引用',
    source: 'selected',
  },
  {
    action: 'node',
    aliases: ['animate', 'anim', 'motion', '图生视频', '转视频', '动起来'],
    command: 'animate',
    description: 'AI video node from selected asset',
    kind: 'video',
    label: '接续视频',
    source: 'selected',
  },
  {
    action: 'flow',
    aliases: ['flow', 'workflow', 'story', 'scene', '流程', '工作流', '创作流'],
    command: 'flow',
    description: 'Grouped image-to-video workflow',
    label: '创作流',
  },
  {
    action: 'storyboard',
    aliases: ['storyboard', 'board', 'shots', 'shotlist', '分镜', '故事板', '镜头'],
    command: 'storyboard',
    description: 'Grouped multi-shot storyboard workflow',
    label: '分镜',
  },
  {
    action: 'variants',
    aliases: ['variants', 'variant', 'versions', 'compare', 'remix', '变体', '版本', '对比', '派生'],
    command: 'variants',
    description: 'Grouped variants from selected asset',
    label: '变体',
    source: 'selected',
  },
  {
    action: 'organize',
    aliases: ['organize', 'tidy', 'layout', 'arrange', '整理', '排版', '布局'],
    command: 'organize',
    description: 'Auto-arrange the current canvas',
    label: '整理',
  },
  {
    action: 'flow',
    aliases: ['ref', 'reference', 'flow-selected', 'flowselect', '素材流', '参考流'],
    command: 'ref',
    description: 'Grouped video workflow from selected asset',
    label: '参考流',
    source: 'selected',
  },
];

export const CANVASPRO_ADD_MENU_GROUPS: AddMenuGroup[] = [
  {
    id: 'nodes',
    label: '添加节点',
    items: [
      {
        action: 'text',
        description: '脚本、广告词、品牌文案',
        id: 'text',
        label: '文本',
      },
      {
        action: 'image',
        description: '宣传图、海报、封面',
        id: 'image',
        label: '图片',
      },
      {
        action: 'video',
        description: '宣传视频、动画、电影',
        id: 'video',
        label: '视频',
      },
      {
        action: 'audio-draft',
        description: '音乐、配音、音效',
        id: 'audio',
        label: '音频',
      },
      {
        action: 'world-draft',
        description: '3D 场景、沉浸空间、虚拟世界',
        id: 'world',
        label: '3D 世界 Beta',
      },
    ],
  },
  {
    id: 'tools',
    label: '辅助工具',
    items: [
      {
        action: 'playlist-draft',
        description: '时间轴串联多段素材',
        id: 'playlist',
        label: '播放列表 Beta',
      },
      {
        action: 'image-editor-draft',
        description: '编辑和处理图片',
        id: 'image-editor',
        label: '图片编辑器',
      },
    ],
  },
  {
    id: 'assets',
    label: '添加资源',
    items: [
      {
        action: 'upload',
        description: '导入 CanvasPro 项目包或 JSON',
        id: 'upload',
        label: '上传',
      },
    ],
  },
];

export const ASSISTANT_ACTIONS: Array<{
  kind: AssistantActionKind;
  label: string;
  title: string;
}> = [
  {
    kind: 'summary',
    label: '总结画布',
    title: '生成当前画布总结',
  },
  {
    kind: 'references',
    label: '找参考',
    title: '根据当前画布生成参考方向',
  },
  {
    kind: 'gaps',
    label: '找缺口',
    title: '指出当前画布还不清楚的地方',
  },
];

export const CONTEXT_ASSISTANT_SUGGESTIONS: Array<{
  icon: typeof Clipboard;
  kind: AssistantActionKind;
  label: string;
  id: string;
  title: string;
}> = [
  {
    icon: Clipboard,
    id: 'next',
    kind: 'next',
    label: '下一步做什么',
    title: '基于当前画布生成下一步行动建议',
  },
  {
    icon: Search,
    id: 'references',
    kind: 'references',
    label: '找相似参考',
    title: '根据当前画布生成参考方向',
  },
  {
    icon: Sparkles,
    id: 'directions',
    kind: 'directions',
    label: '给三个方向',
    title: '生成三条可以继续展开的创意方向',
  },
];

export const SELECTED_CONTEXT_ACTIONS: Array<{
  icon: typeof ImageIcon;
  id: SelectedContextActionKind;
  label: string;
  title: string;
}> = [
  {
    icon: ImageIcon,
    id: 'image',
    label: '参考生图',
    title: '从选中素材创建参考图像节点',
  },
  {
    icon: Video,
    id: 'video',
    label: '接续视频',
    title: '从选中素材创建视频节点',
  },
  {
    icon: Sparkles,
    id: 'variants',
    label: '三版变体',
    title: '从选中素材生成三版对比',
  },
  {
    icon: Workflow,
    id: 'flow',
    label: '参考流',
    title: '从选中素材创建图片到视频创作流',
  },
  {
    icon: Link2,
    id: 'reference',
    label: '引用说明',
    title: '从选中素材创建文字引用节点',
  },
];

export const GENERATION_ASPECT_RATIO_OPTIONS = [
  { label: '自适应', value: 'auto' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '21:9', value: '21:9' },
];

export const GENERATION_QUALITY_OPTIONS = [
  { label: '快速', value: 'fast' },
  { label: '平衡', value: 'balanced' },
  { label: '高清', value: 'high' },
];

export const IMAGE_GENERATION_RESOLUTION_OPTIONS = [
  { label: '2K', value: '2K' },
  { label: '3K', value: '3K' },
];

export const VIDEO_GENERATION_RESOLUTION_OPTIONS = [
  { label: '720P', value: '720P' },
  { label: '1080P', value: '1080P' },
];

export const IMAGE_GENERATION_MODE_OPTIONS = [
  { label: '图像生成', value: 'text-to-image' },
  { label: '参考生图', value: 'reference-to-image' },
];

export const VIDEO_GENERATION_MODE_OPTIONS = [
  { label: '首尾帧', value: 'image-to-video' },
  { label: '文生视频', value: 'text-to-video' },
];

export const IMAGE_GENERATION_MODEL_OPTIONS = [
  { label: '即梦5.0 Lite', value: 'doubao-seedream-5.0-lite' },
  { label: 'Auto', value: 'auto' },
  { label: 'Image Fast', value: 'image-fast' },
  { label: 'Image Pro', value: 'image-pro' },
];

export const VIDEO_GENERATION_MODEL_OPTIONS = [
  { label: 'Wan 2.2', value: 'wan-2.2' },
  { label: 'Auto', value: 'auto' },
  { label: 'Video Fast', value: 'video-fast' },
  { label: 'Video Pro', value: 'video-pro' },
];

export type BridgeStats = {
  canvasCount?: number;
  edgeCount?: number;
  nodeCount?: number;
};

export type GenerationTaskSettings = {
  aspectRatio?: string;
  durationSeconds?: number;
  mode?: string;
  model?: string;
  outputCount?: number;
  quality?: string;
  resolution?: string;
};

export type GenerationTaskCostEstimate = {
  credits?: number;
  label?: string;
  unit?: string;
};

export type GenerationTaskOutput = {
  createdAt?: string;
  id?: string;
  index?: number;
  kind?: string;
  label?: string;
  materializedAt?: string;
  mediaUrl?: string;
  nodeId?: string;
  posterUrl?: string;
  status?: string;
  updatedAt?: string;
};

export type GenerationTaskSourceInput = {
  index?: number;
  inputValue?: string;
  kind?: string;
  nodeId?: string;
  nodeName?: string;
  refSlot?: string;
  status?: string;
  value?: string;
};

export type GenerationTaskExecutor = {
  atom?: string;
  authStatus?: {
    browserStateExists?: boolean;
    cookieCount?: number;
    hasToken?: boolean;
    ready?: boolean;
    status?: string;
  };
  capabilityId?: string;
  cliStatus?: {
    ready?: boolean;
    status?: string;
  };
  commandPreview?: string;
  missingInputs?: string[];
  mode?: string;
  provider?: string;
  readyForExecution?: boolean;
};

export type CanvasProCliDefaults = {
  hasCanvasproBotId?: boolean;
  hasCanvasproSlug?: boolean;
  hasCanvasproSlugId?: boolean;
};

export type CanvasProCliStatus = {
  auth?: {
    art?: {
      browserStateExists?: boolean;
      cookieCount?: number;
      hasToken?: boolean;
      ready?: boolean;
      status?: string;
    };
    dreamy?: {
      ready?: boolean;
      status?: string;
    };
  };
  binary?: string;
  commandPrefix?: string[];
  cwd?: string;
  defaults?: CanvasProCliDefaults;
  message?: string;
  provider?: string;
  ready?: boolean;
  repoExists?: boolean;
  repoPath?: string;
  status?: string;
};

export type CanvasProCliAuthRaw = {
  authenticated?: boolean;
  browser_state_exists?: boolean;
  browserStateExists?: boolean;
  cookie_count?: number;
  cookieCount?: number;
  has_token?: boolean;
  hasToken?: boolean;
};

export type CanvasProCliAuthStatus = {
  cliStatus?: CanvasProCliStatus;
  commandPreview?: string;
  message?: string;
  provider?: string;
  raw?: CanvasProCliAuthRaw;
  ready?: boolean;
  returnCode?: number;
  status?: string;
};

export type CliLoginMethod = 'token' | 'cookie';

export type GenerationTask = {
  backendMessage?: string;
  costEstimate?: GenerationTaskCostEstimate;
  createdAt?: string;
  executor?: GenerationTaskExecutor;
  externalTaskId?: string;
  id?: string;
  kind?: string;
  label?: string;
  missingNode?: boolean;
  nodeDeletedAt?: string;
  nodeId?: string;
  nodeName?: string;
  nodeType?: string;
  outputs?: GenerationTaskOutput[];
  progress?: number;
  prompt?: string;
  settings?: GenerationTaskSettings;
  sourceInputs?: GenerationTaskSourceInput[];
  sourceNodeIds?: string[];
  status?: string;
  submittedAt?: string;
  updatedAt?: string;
};

export type GenerationAutoSyncState = {
  active: boolean;
  materialized?: number;
  message?: string;
  syncedAt?: string;
  taskId?: string;
};

export type AssistantRunStep = {
  detail?: string;
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
};

export type AssistantRunTrace = {
  mode: AssistantExecutionMode;
  prompt?: string;
  status: 'idle' | 'running' | 'done' | 'error';
  steps: AssistantRunStep[];
  title: string;
  updatedAt?: string;
};

export type GenerationTasksResult = {
  apiReachable?: boolean | null;
  stats?: BridgeStats;
  tasks?: GenerationTask[];
};

export type FocusGenerationTaskResult = {
  apiReachable?: boolean | null;
  message?: string;
  missingNode?: boolean;
  nodeId?: string;
  selected?: boolean;
  stats?: BridgeStats;
  task?: GenerationTask;
};

export type UpdateGenerationTaskResult = {
  apiReachable?: boolean | null;
  nodeId?: string;
  prompt?: string;
  selected?: boolean;
  stats?: BridgeStats;
  task?: GenerationTask;
};

export type SubmitGenerationTaskResult = UpdateGenerationTaskResult;

export type SyncGenerationTaskResult = UpdateGenerationTaskResult & {
  materializedOutputs?: MaterializeGenerationOutputResult[];
  syncedAt?: string;
};

export type MaterializeGenerationOutputResult = {
  apiReachable?: boolean | null;
  created?: boolean;
  edgeId?: string;
  nodeId?: string;
  outputId?: string;
  outputIndex?: number;
  outputKind?: string;
  outputNodeId?: string;
  selected?: boolean;
  stats?: BridgeStats;
};

export type ContinueGenerationOutputResult = {
  apiReachable?: boolean | null;
  created?: boolean;
  continuation?: CreateNodeResult | CreateVariantsResult;
  outputNodeId?: string;
  stats?: BridgeStats;
};

export type RerunGenerationTaskResult = {
  action?: GenerationTaskRerunAction | string;
  apiReachable?: boolean | null;
  edgeIds?: string[];
  model?: string;
  nodeId?: string;
  nodeType?: string;
  previousModel?: string;
  prompt?: string;
  selected?: boolean;
  stats?: BridgeStats;
  task?: GenerationTask;
};

export type RestoreGenerationTaskNodeResult = {
  apiReachable?: boolean | null;
  edgeIds?: string[];
  nodeId?: string;
  nodeType?: string;
  restored?: boolean;
  selected?: boolean;
  stats?: BridgeStats;
  task?: GenerationTask;
};

export type RemoveGenerationTaskResult = {
  apiReachable?: boolean | null;
  removed?: boolean;
  stats?: BridgeStats;
  taskId?: string;
};

export type CreateNodeResult = {
  apiReachable?: boolean | null;
  autoPrepared?: boolean;
  contentSeeded?: boolean;
  edgeId?: string;
  nodeId?: string;
  nodeType?: string;
  prepareMessage?: string;
  promptSeeded?: boolean;
  selected?: boolean;
  sourceNodeId?: string;
  stats?: BridgeStats;
  task?: GenerationTask;
};

export type ImportMediaFilesResult = {
  imported?: number;
  kindLabels?: string[];
  nodeIds?: string[];
  skipped?: string[];
  stats?: BridgeStats;
};

export type CreateFlowResult = {
  apiReachable?: boolean | null;
  edgeId?: string;
  groupId?: string;
  imageNodeId?: string;
  promptSeeded?: boolean;
  selected?: boolean;
  sourceMediaKind?: string;
  sourceNodeId?: string;
  sourceReparented?: boolean;
  stats?: BridgeStats;
  videoNodeId?: string;
};

export type CreateStoryboardResult = {
  apiReachable?: boolean | null;
  edgeIds?: string[];
  groupId?: string;
  imageNodeIds?: string[];
  promptSeeded?: boolean;
  selected?: boolean;
  stats?: BridgeStats;
  videoNodeIds?: string[];
};

export type CreateVariantsResult = {
  apiReachable?: boolean | null;
  edgeIds?: string[];
  groupId?: string;
  outputNodeIds?: string[];
  outputNodeType?: string;
  promptSeeded?: boolean;
  selected?: boolean;
  sourceMediaKind?: string;
  sourceNodeId?: string;
  sourceReparented?: boolean;
  stats?: BridgeStats;
};

export type OrganizeCanvasResult = {
  apiReachable?: boolean | null;
  arrangedGroupCount?: number;
  arrangedNodeCount?: number;
  selected?: boolean;
  stats?: BridgeStats;
  unitCount?: number;
};

export type CreateAssistantNoteResult = {
  action?: AssistantActionKind;
  apiReachable?: boolean | null;
  contentSeeded?: boolean;
  noteId?: string;
  selected?: boolean;
  stats?: BridgeStats;
};

export type BridgeStatus = {
  apiReachable?: boolean | null;
  bridgeVersion?: string;
  error?: string;
  lastAutosave?: AutosavePayload | null;
  ready?: boolean;
  stats?: BridgeStats;
};

export type AutosavePayload = {
  apiReachable?: boolean | null;
  projectName?: string;
  reason?: string;
  savedAt?: string;
  stats?: BridgeStats;
};

export type BridgeResponseMessage = {
  collapsed?: boolean;
  error?: string;
  id?: string;
  ok?: boolean;
  open?: boolean;
  payload?: unknown;
  type?: string;
};

export type PendingBridgeRequest = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  timeout: number;
};

export interface CanvasProProps {
  embeddedInStudio?: boolean;
  onBackToStudio?: () => void;
}

export function createRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function formatSavedAt(value?: string) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

export function formatGenerationTaskKind(kind?: string) {
  return kind === 'video' ? '视频' : kind === 'image' ? '图像' : '生成';
}

export function formatGenerationTaskStatus(task: GenerationTask) {
  if (task.missingNode) return '节点已删除';
  if (task.label) return task.label;
  if (task.status === 'draft') return '离线草稿';
  if (task.status === 'ready') return '待连接服务';
  if (task.status === 'queued') return '已加入队列';
  if (task.status === 'running') return '生成中';
  if (task.status === 'done') return '已完成';
  if (task.status === 'error') return '失败';
  return '等待生成';
}

export function formatGenerationTaskAtom(task?: GenerationTask | null) {
  const executor = task?.executor || {};
  if (executor.provider === 'myshell-art-cli') {
    if (executor.atom === 'generate-create') return 'MyShell Art CLI / Art Generate';
    if (executor.atom === 'upload-image') return 'MyShell Art CLI / Upload Image';
    if (executor.atom === 'energy-balance') return 'MyShell Art CLI / Energy Balance';
    return 'MyShell Art CLI / Dreamy Generate';
  }
  if (executor.provider === 'myshell-art-api') return 'MyShell Art API';
  return '未绑定';
}

export function formatGenerationTaskAtomHint(task?: GenerationTask | null) {
  if (task?.missingNode) return '可恢复到画布';
  const executor = task?.executor || {};
  const missingInputs = Array.isArray(executor.missingInputs) ? executor.missingInputs.filter(Boolean) : [];
  if (missingInputs.length) return `需要 ${missingInputs.join(' / ')}`;
  if (executor.readyForExecution) return '可执行';
  if (executor.authStatus?.status === 'auth_missing') return '待鉴权';
  if (executor.cliStatus?.status === 'not_installed') return '未安装';
  if (executor.mode === 'draft') return '待预检';
  return executor.mode === 'execute' ? '已执行' : '已预检';
}

export function isCliAuthReady(status?: CanvasProCliAuthStatus | null) {
  if (status?.ready) return true;
  const raw = status?.raw || {};
  return Boolean(
    raw.authenticated ||
      raw.has_token ||
      raw.hasToken ||
      Number(raw.cookie_count || raw.cookieCount || 0) > 0 ||
      raw.browser_state_exists ||
      raw.browserStateExists,
  );
}

export function formatCliAuthLabel(status?: CanvasProCliAuthStatus | null, loading = false) {
  if (loading && !status) return 'CLI 检查中';
  if (status?.cliStatus?.status === 'not_installed' || status?.status === 'not_installed') return 'CLI 未安装';
  if (status?.status === 'error') return 'CLI 异常';
  if (isCliAuthReady(status)) return 'CLI 已登录';
  return loading ? 'CLI 刷新中' : 'CLI 待登录';
}

export function formatCliAuthDetail(status?: CanvasProCliAuthStatus | null) {
  if (!status) return '读取 MyShell CLI 状态';
  const raw = status.raw || {};
  const cookieCount = Number(raw.cookie_count || raw.cookieCount || 0);
  const pieces = [
    raw.has_token || raw.hasToken ? 'token' : '',
    cookieCount ? `${cookieCount} cookies` : '',
    raw.browser_state_exists || raw.browserStateExists ? 'browser state' : '',
  ].filter(Boolean);
  return pieces.length ? pieces.join(' · ') : status.message || '未登录';
}

export function formatCliDefaultLabel(defaults?: CanvasProCliDefaults) {
  if (!defaults) return '默认节点未配置';
  const hasDreamy = defaults.hasCanvasproSlugId || defaults.hasCanvasproBotId;
  const hasArt = defaults.hasCanvasproSlug || defaults.hasCanvasproBotId;
  if (hasDreamy && hasArt) return '默认节点已配置';
  if (hasDreamy || hasArt) return '默认节点部分配置';
  return '默认节点未配置';
}

export function formatGenerationOutputStatus(output: GenerationTaskOutput) {
  if (output.label) return output.label;
  if (output.status === 'done') return '已生成';
  if (output.status === 'running') return '生成中';
  if (output.status === 'pending') return '等待结果';
  if (output.status === 'waiting_service') return '待连接服务';
  if (output.status === 'error') return '失败';
  return '等待结果';
}

export function formatGenerationSourceInputStatus(input: GenerationTaskSourceInput) {
  if (input.status === 'remote') return '远端可用';
  if (input.status === 'staged') return '已转存';
  if (input.status === 'ready' || input.inputValue) return '可用';
  if (input.status === 'browser_only') return '本地素材';
  if (input.status === 'unsupported') return '需上传';
  return '缺少地址';
}

export function getGenerationModeOptions(kind?: string) {
  return kind === 'video' ? VIDEO_GENERATION_MODE_OPTIONS : IMAGE_GENERATION_MODE_OPTIONS;
}

export function getGenerationModelOptions(kind?: string) {
  return kind === 'video' ? VIDEO_GENERATION_MODEL_OPTIONS : IMAGE_GENERATION_MODEL_OPTIONS;
}

export function getGenerationResolutionOptions(kind?: string) {
  return kind === 'video' ? VIDEO_GENERATION_RESOLUTION_OPTIONS : IMAGE_GENERATION_RESOLUTION_OPTIONS;
}

export function getDefaultGenerationAspectRatio(kind?: string) {
  return kind === 'video' ? '16:9' : '9:16';
}

export function getDefaultGenerationMode(kind?: string) {
  return kind === 'video' ? 'text-to-video' : 'text-to-image';
}

export function getDefaultGenerationModel(kind?: string) {
  return kind === 'video' ? 'wan-2.2' : 'doubao-seedream-5.0-lite';
}

export function getDefaultGenerationResolution(kind?: string) {
  return kind === 'video' ? '1080P' : '2K';
}

export function formatGenerationOptionLabel(options: Array<{ label: string; value: string }>, value: string) {
  return options.find((option) => option.value === value)?.label || value;
}

export function formatGenerationTaskParamSummary(
  kind: string | undefined,
  settings: Required<GenerationTaskSettings>,
  costEstimate?: GenerationTaskCostEstimate,
  sourceInputs: GenerationTaskSourceInput[] = [],
) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const model = formatGenerationOptionLabel(getGenerationModelOptions(mediaKind), settings.model);
  const mode = formatGenerationOptionLabel(getGenerationModeOptions(mediaKind), settings.mode);
  const countLabel = `${settings.outputCount || 1}x`;
  const costLabel = costEstimate?.label || estimateGenerationTaskCost(mediaKind, settings).label || '';
  const readyInputs = sourceInputs.filter((input) => input.inputValue || input.status === 'ready').length;
  const inputLabel = sourceInputs.length ? `输入 ${readyInputs}/${sourceInputs.length}` : '';
  const pieces =
    mediaKind === 'video'
      ? [
          model,
          mode,
          settings.aspectRatio,
          settings.resolution,
          `${settings.durationSeconds || 5}s`,
          inputLabel,
          countLabel,
          costLabel,
        ]
      : [model, settings.aspectRatio, settings.resolution, inputLabel, countLabel, costLabel];
  return pieces.filter(Boolean).join(' · ');
}

export function normalizeGenerationResolution(kind: string | undefined, value: unknown) {
  const normalized = String(value || '').trim().toUpperCase();
  const allowedValues = new Set(getGenerationResolutionOptions(kind).map((option) => option.value));
  return allowedValues.has(normalized) ? normalized : getDefaultGenerationResolution(kind);
}

export function estimateGenerationTaskCost(kind: string | undefined, settings: GenerationTaskSettings): GenerationTaskCostEstimate {
  const outputCount = Math.max(1, Math.min(Number(settings.outputCount) || 1, 4));
  const resolution = normalizeGenerationResolution(kind, settings.resolution);
  if (kind === 'video') {
    const durationSeconds = Math.max(2, Math.min(Number(settings.durationSeconds) || 5, 12));
    const durationBlocks = Math.max(1, Math.ceil(durationSeconds / 5));
    const perBlock = resolution === '1080P' ? 50 : 35;
    const credits = perBlock * durationBlocks * outputCount;
    return { credits, label: `约 ${credits} 点`, unit: 'credits' };
  }
  const perOutput = resolution === '3K' ? 8 : 5;
  const credits = perOutput * outputCount;
  return { credits, label: `约 ${credits} 点`, unit: 'credits' };
}

export function getGenerationTaskProgress(task: GenerationTask) {
  const progress = Number(task.progress);
  if (!Number.isFinite(progress)) return task.status === 'done' ? 100 : 0;
  return Math.max(0, Math.min(100, progress));
}

export function normalizeGenerationTaskSettings(task?: GenerationTask | null): Required<GenerationTaskSettings> {
  const settings = task?.settings || {};
  const aspectRatioValues = new Set(GENERATION_ASPECT_RATIO_OPTIONS.map((option) => option.value));
  const aspectRatio = aspectRatioValues.has(String(settings.aspectRatio || ''))
    ? String(settings.aspectRatio)
    : getDefaultGenerationAspectRatio(task?.kind);
  const modeValues = new Set(getGenerationModeOptions(task?.kind).map((option) => option.value));
  const mode = modeValues.has(String(settings.mode || '')) ? String(settings.mode) : getDefaultGenerationMode(task?.kind);
  const modelValues = new Set(getGenerationModelOptions(task?.kind).map((option) => option.value));
  const model = modelValues.has(String(settings.model || ''))
    ? String(settings.model)
    : getDefaultGenerationModel(task?.kind);
  const qualityValues = new Set(GENERATION_QUALITY_OPTIONS.map((option) => option.value));
  const quality = qualityValues.has(String(settings.quality || '')) ? String(settings.quality) : 'balanced';
  const resolution = normalizeGenerationResolution(task?.kind, settings.resolution);
  const outputCount = Math.max(1, Math.min(Number(settings.outputCount) || 1, 4));
  const durationSeconds = task?.kind === 'video'
    ? Math.max(2, Math.min(Number(settings.durationSeconds) || 5, 12))
    : 0;
  return { aspectRatio, durationSeconds, mode, model, outputCount, quality, resolution };
}

export function getGenerationTaskKey(task?: GenerationTask | null) {
  return String(task?.id || task?.nodeId || '');
}

export function hasUnmaterializedGenerationOutput(task?: GenerationTask | null) {
  return Boolean(task?.outputs?.some((output) => output.mediaUrl && !output.nodeId));
}

export function isAutoSyncGenerationTask(task?: GenerationTask | null) {
  const status = String(task?.status || '').toLowerCase();
  const externalTaskId = String(task?.externalTaskId || '').trim();
  if (!task || !getGenerationTaskKey(task)) return false;
  if (task.missingNode) return false;
  if (hasUnmaterializedGenerationOutput(task)) return true;
  if (!externalTaskId) return false;
  return ['queued', 'running', 'pending', 'submitted'].includes(status);
}

export function getGenerationTaskCompletedOutputCount(task?: GenerationTask | null) {
  return task?.outputs?.filter((output) => output.mediaUrl || output.status === 'done').length || 0;
}

export function getGenerationTaskOutputCount(task?: GenerationTask | null) {
  return task?.outputs?.length || Math.max(1, Math.min(Number(task?.settings?.outputCount) || 1, 4));
}

export function parseQuickCreateCommand(
  value: string,
): { action: QuickCreateAction; kind?: QuickCreateKind; prompt: string; source?: 'selected' } | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const commandText = match[1].toLowerCase();
  const command = QUICK_CREATE_COMMANDS.find((item) =>
    item.aliases.some((alias) => alias.toLowerCase() === commandText),
  );
  if (!command) return null;
  return {
    action: command.action || 'node',
    kind: command.kind,
    prompt: (match[2] || '').trim(),
    source: command.source,
  };
}

export function getAddMenuIcon(itemId: string) {
  if (itemId === 'text') return FileText;
  if (itemId === 'image') return ImageIcon;
  if (itemId === 'video') return Video;
  if (itemId === 'audio') return Music;
  if (itemId === 'world') return Box;
  if (itemId === 'playlist') return ListVideo;
  if (itemId === 'image-editor') return Paintbrush;
  if (itemId === 'upload') return Upload;
  return Sparkles;
}

export function buildAddMenuDraftContent(action: AddMenuAction, prompt: string) {
  const request = prompt.trim();
  if (action === 'audio-draft') {
    return [
      '# 音频',
      '用途：音乐、配音、音效',
      request ? `需求：${request}` : '需求：描述音乐情绪、配音角色、音效节奏或参考素材。',
      '状态：待接入音频生成原子能力。',
    ].join('\n');
  }
  if (action === 'world-draft') {
    return [
      '# 3D 世界 Beta',
      '用途：3D 场景、沉浸空间、虚拟世界',
      request ? `需求：${request}` : '需求：描述空间结构、镜头动线、角色或可交互物件。',
      '状态：待接入 3D 世界生成原子能力。',
    ].join('\n');
  }
  if (action === 'playlist-draft') {
    return [
      '# 播放列表 Beta',
      '用途：时间轴串联多段素材',
      request ? `需求：${request}` : '需求：列出镜头顺序、每段时长、转场和配乐节奏。',
      '状态：可先用分镜或图片到视频创作流拆成素材节点。',
    ].join('\n');
  }
  return [
    '# 图片编辑器',
    '用途：编辑和处理图片',
    request ? `需求：${request}` : '需求：描述要裁剪、修补、扩图、换背景或统一风格的图片。',
    '状态：待接入图片编辑原子能力。',
  ].join('\n');
}
