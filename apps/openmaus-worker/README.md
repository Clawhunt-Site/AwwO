# AwwO 托管 OpenMaus worker

这是 AwwO 内部执行服务。用户只在 AwwO 选择模型和发送任务；不需要登录或配置另一个 OpenMaus 实例。每个 run 启动独立 OpenMaus OSS 核心，自动建立本次任务的会话，结束后清理进程、工作区容器和临时资料。没有模型、核心或 Docker 工作区时，服务明确返回未就绪，不宣称能够执行。

## 准备与启动

要求 Node.js 24 或更新版本、Git、npm、可用的 Docker daemon，以及预先构建的 AwwO workspace 镜像。部署人员配置 Docker；最终用户不配置它。

```sh
npm --prefix apps/openmaus-worker ci --ignore-scripts
npm --prefix apps/openmaus-worker run setup
AWWO_OPENMAUS_TOKEN='<内部随机服务令牌，至少32字符>' \
AWWO_OPENMAUS_DOCKER=/usr/bin/docker \
AWWO_OPENMAUS_WORKSPACE_IMAGE='<已构建镜像或固定image ID>' \
npm --prefix apps/openmaus-worker start
```

`setup` fetch 精确提交 `104fd17b8f7767e71ba3cf40f27f9c6279b507bd`，用该提交的 pnpm lockfile 和 pnpm 10.33.0 安装依赖（禁用安装脚本），再构建 server bundle。可用 `AWWO_OPENMAUS_SOURCE=/绝对路径` 复用同一提交的干净源码。请停止 worker 后再重新 setup；该操作替换本地 `.runtime/core`。构建不含 `enterprise/`，产物保留上游 LICENSE、NOTICE 和 third_party 许可证。

构建对上游应用三处受检查的限制：OpenAI-compatible driver 关闭 computerUse；MCP mount 只允许固定的 `awwo_workspace`；agents/composio capabilities 关闭。其余启动配置关闭浏览器、共享电脑、技能编写、自动回忆和自动标题。运行环境只含专用 HOME/TMPDIR、Node 路径与必要核心设置，不继承提供商凭证。

| 环境变量 | 说明 |
| --- | --- |
| `AWWO_OPENMAUS_TOKEN` | 仅内部 backend → worker 鉴权，至少 32 字符 |
| `AWWO_OPENMAUS_HOST` / `AWWO_OPENMAUS_PORT` | 默认 `127.0.0.1:8099`，不要直接暴露公网 |
| `AWWO_OPENMAUS_DOCKER` | 受信任 Docker CLI 的绝对路径；Mac 通常 `/usr/local/bin/docker` |
| `AWWO_OPENMAUS_DOCKER_CONTEXT` | 可选 Docker context |
| `AWWO_OPENMAUS_WORKSPACE_IMAGE` | 已有 workspace image，启动不会自动 pull；建议固定 digest/ID |
| `AWWO_OPENMAUS_MODEL_PROXY_ORIGINS` | 逗号分隔的 backend 模型代理 origin 白名单；未设置仅允许 loopback |
| `AWWO_OPENMAUS_MAX_CONCURRENT` | 默认 2，范围 1–8 |
| `AWWO_OPENMAUS_CORE_PATH` | 可选已构建 `dist-server/index.js` 绝对路径，旁边须有 build manifest |
| `AWWO_OPENMAUS_DATA_DIR` | 可选任务临时目录的绝对路径，默认 `.runs` |

## 内部契约

所有路由要求 `Authorization: Bearer AWWO_OPENMAUS_TOKEN`，拒绝浏览器 Origin。

- `GET /health`：就绪 HTTP 200；核心/工作区不可用 HTTP 503。固定服务名 `awwo-openmaus-worker`，返回 `ready/configured/status/reason`、能力和上游提交。
- `POST /internal/runs`：请求包含 `runId, tenantId, sessionId, prompt, instructions, modelProxyURL, modelProxyToken, timeoutMs, maxModelCalls`；返回 SSE。三个 ID 是不透明作用域标识，绝不拼接文件路径。
- `POST /internal/runs/:runId/respond`：`{requestId,behavior:"allow"|"deny",message?}`。问题的 allow 必须包含非空回答。完全相同答复可重放，冲突答复返回 409；不重试不确定的写操作。
- `DELETE /internal/runs/:runId`：HTTP 202，取消本次任务。SSE 断连同样取消。

SSE 包括 `computer_message`、`computer_approval`、`computer_artifact`，以及单个终态 `completed/failed/cancelled`。审批使用上游原生 Ask gate，批准前不执行工具；`arguments` 保留模型发起的完整 JSON 参数。可显示的 title/description 截断不修改实际工具参数。artifact 的 `name` 为 basename，`path` 保存原始相对路径，内容为 base64，`sha256` 来自实际沙箱字节。

工具审批卡只与它审批的那一次调用配对（`runtime.ts` 的 `cardCall`）：broker 按顺序记下核心每次声明了工具的模型请求所得答案中的每个工具调用（模型的调用 id、工具名，以及能取到的参数：512 KiB 以内的 JSON 对象；不声明工具的辅助请求，其答案不记）；核心逐个处理调用，每处理一个就留下带该调用 id 的活动记录（被核心拒绝的调用当即留下，有卡片的调用在卡片答复后才留下），所以一张打开的卡片属于第一个既无活动、也未配卡的调用（核心未提供的工具名在任何卡片之前就被拒绝，且可能不留活动，不计在内）。该调用不是卡片上的工具、另有调用与它同一 id，或其参数未能取到，任务即以 `APPROVAL_CALL_UNMATCHED` / `APPROVAL_ARGUMENTS_UNAVAILABLE` 停止，绝不显示或批准另一次调用的参数。工具执行时，核心传来的工具名和参数必须与一张已批准卡片的调用完全相同，每次批准只执行一次，核心没有接受（或答复失败）的批准不执行任何调用；否则不执行并以 `TOOL_CALL_NOT_ALLOWED` 停止任务。工具审批事件一定带 `arguments`；API 收到没有 `arguments` 的工具审批即以 `invalid_computer_approval` 结束任务，不会当作空参数自动批准。

模型代理接收非流式 Chat Completions JSON（worker 设置 `stream:false`），允许文本/null 内容、function tool calls、tool results 以及 Responses encrypted `reasoning_details` 回传。模型名固定为 `awwo-model`；由 AwwO backend 选择真实模型。真正的提供商 key 不进入核心，核心只持有本次 run 的本地 relay 凭证。代理跳转被拒绝；调用次数包括失败尝试。

## 执行边界

固定六个 MCP 工具：`list/read/write/exec/publish/archive`，另有核心原生 `ask_user`。所有文件与命令都通过现有 `workspace-sandbox.ts` 进入真实 Docker 容器：无网络、只读根文件系统、非 root、无 host mounts、资源限制。不存在桌面、浏览器、终端模拟或主机 shell 工具。Docker socket 仅由受信任 worker 使用，模型和沙箱均无法访问。

- 请求 512 KiB；prompt 256 KiB；instructions 128 KiB；工具审批参数 512 KiB。
- 单文件/ZIP 2 MiB；产物总计 8 MiB、最多 16 个；同路径同 SHA 不重复发布。
- 单 SSE 3 MiB，总事件 16 MiB；积压超限主动取消，避免无限内存。
- 消息 64 KiB，输出 256 KiB，标题 200 bytes，描述 8 KiB；按 UTF-8 边界截断，附 `truncated:true` 和可见标记。
- 默认 5 分钟、最多 15 分钟；默认 16 次、最多 32 次模型请求。核心本身另有工具轮次/数量上限。
- 原生拒绝/工具失败会导致 failed，最终文本不能把未成功执行的任务变成成功。工作区未受影响、模型可以改正或说明的失败（路径不对、文件不存在、文件或目录过大、`inputs/` 只读、产物超额等，见 `tool-failures.ts`）以普通结果返回：`failed:true`、固定错误码和固定说明（发布/打包另有 `published:false`），不转述沙箱输出；其余失败（文件校验失败、沙箱已关闭、无法解析的响应、未知错误）仍是 `isError`。
- 核心只把工具结果的前 50 KiB（UTF-8）交给模型，在哪截断就在哪截断。所以 `read` 的整个结果（JSON 编码后）不超过 50 KiB：更长的文件只返回能放下的开头，并在正文之前附 `truncated:true`，其余部分可用 `exec` 读取；`write` 只返回路径、字节数和 SHA，不回显内容（避免核心 2 MiB 回复帧上限中断回合）。
- 参数不符合工具 schema 的调用（多余字段、缺字段、类型不对）由核心自己拒绝，同样会让该回合拿不到最终回答；broker 无法把它变成普通结果，要改需要给核心打补丁。
- 完成与失败都等待清理；清理无法确认时返回 `CLEANUP_FAILED`。进程遭 SIGKILL/机器掉电后不能保证自动回收，应由部署监督器检查带 `awwo.workspace-sandbox=true` 标签的孤立容器，避免删除其它活跃 worker 的容器。

## 测试

```sh
npm --prefix apps/openmaus-worker run typecheck
npm --prefix apps/openmaus-worker test
AWWO_OPENMAUS_REAL_TEST=1 \
AWWO_TEST_DOCKER_EXECUTABLE=/usr/local/bin/docker \
AWWO_TEST_WORKSPACE_IMAGE='<本机实际image ID或tag>' \
AWWO_TEST_DOCKER_CONTEXT=desktop-linux \
npm --prefix apps/openmaus-worker test
```

普通测试覆盖参数、鉴权、字节上限、工具白名单、产物哈希和调用预算。显式真实集成测试使用真实 pinned core 与真实 Docker，只有模型 HTTP 返回是固定 fixture，用于可重复验证审批、文件写入、exec、publish、问题回答、拒绝、取消、断连与清理；它不代表真实提供商模型验收。
