import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";

export const type = "imagegen_local";
export const label = "图像生成 (RunningHub)";

/**
 * The model dropdown carries the RunningHub workflow id (the model combo
 * accepts free text). At createServerAdapter() time we read the instance
 * default RUNNINGHUB_WORKFLOW_ID: when set, it becomes the one real model
 * entry; when unset, a clearly-labeled placeholder entry keeps the model
 * selector alive and tells the user to type the numeric id. The placeholder
 * id is deliberately non-numeric — execute() treats it as "no selection"
 * and fails closed with instructions instead of calling the API with it.
 */
export function buildModels(): AdapterModel[] {
  const envDefault = (process.env.RUNNINGHUB_WORKFLOW_ID ?? "").trim();
  if (envDefault) {
    return [{ id: envDefault, label: `默认工作流 ${envDefault}` }];
  }
  return [{ id: "workflow-id", label: "在模型栏填 RunningHub 工作流数字 ID" }];
}

/** Module-load-time snapshot; createServerAdapter() re-reads the env. */
export const models = buildModels();

export const agentConfigurationDoc = `# imagegen_local agent configuration

Adapter: imagegen_local（RunningHub 图像生成）

这是一个图像生成 agent runtime：唤醒时取最新的用户评论（回退到 issue 标题+描述）作为提示词，
通过 RunningHub OpenAPI 运行一个 ComfyUI 工作流生成图片，把输出文件下载到执行工作区的
\`imagegen/\` 目录，逐张上传为 issue 附件 + artifact work product，最后在 issue 上发一条
列出所有图片的评论（并注明提示词注入的节点，便于排查注错节点的问题）。

API key（fail-closed，两个来源按序解析，绝不写入日志）:
1. agent env secret 绑定 \`RUNNINGHUB_API_KEY\`（推荐，按 agent 隔离）
2. 实例环境变量 \`RUNNINGHUB_API_KEY\`（整机默认值）
两者都缺失时 testEnvironment 报 error、执行直接失败。

工作流选择（模型栏就是 RunningHub id，模型下拉接受自由输入文本）:
- 纯数字 = workflowId → POST /task/openapi/create
- \`app:<数字>\` = webappId → POST /task/openapi/ai-app/run
- 模型栏为空或不是合法 id 时按序回退: config.workflowId → 实例环境变量 RUNNINGHUB_WORKFLOW_ID
- 全部缺失时执行失败并给出指引。设置了实例默认 RUNNINGHUB_WORKFLOW_ID 时，
  模型下拉会显示「默认工作流 <id>」；否则显示一个占位条目提示直接输入数字 ID
 （占位条目本身不是可用 id）。

提示词注入（nodeInfoList）:
- promptNodeId (config，默认取实例环境变量 RUNNINGHUB_PROMPT_NODE_ID，再默认 "6")
- promptField (config，默认 "text")
提示词会写入该节点的该字段；最终评论会注明实际使用的 nodeId/fieldName。

可选配置:
- timeoutSec (number): 创建+轮询+下载的总超时（秒），默认 300；超时会尽力取消任务
- pollIntervalMs (number): 状态轮询间隔（毫秒），默认 3000
- cwd (string): 工作目录回退值（优先用工作区投影的 cwd）
- apiUrl (string): Paperclip API base 覆盖（默认按 PAPERCLIP_RUNTIME_API_URL / SUPERCLAW_API_URL / PAPERCLIP_API_URL 解析）
- runninghubApiBase (string): RunningHub API base 覆盖，默认 https://www.runninghub.cn
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models: buildModels(),
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
  };
}
