# AwwO 通过 Amazon Bedrock 提供模型

状态：生产启用中。2026-10-03 开放 23 个区域内模型，2026-10-04 再开放 19 个经跨区域推理配置文件调用的模型（Claude 8 个、Grok 2 个、Kimi K3、DeepSeek R1、Pixtral Large、Llama 3 个、Nova 3 个），内置目录 `builtin` 共 42 个，三个 worker 都提供；2026-10-07 下架 Fable 5 与 5.1 后为 40 个（目录 48 项），Opus 5.5 改回 global 推理配置文件（见文末）。凭证来自 AwwO 专用的 EC2 实例角色，只允许目录里的这些模型；实例凭证只对三个 worker 开放。Claude Sonnet 5.5 与 7 个 GPT 尚未开放：AWS Marketplace 以 `INVALID_PAYMENT_INSTRUMENT` 拒绝订阅，账号补上有效付款方式后才能订阅并验收（见文末 2026-10-04 记录）。

运营方在自己的 AWS 账号里调用 Bedrock，AwwO 的模型架子因此可以列出 Claude、GPT、Grok、Kimi、DeepSeek、Qwen、GLM、MiniMax、Mistral、Llama、Nova、Gemma、Nemotron 等约 50 个热门模型。LLM Gate 保持不变：Bedrock 上没有的模型（例如 Gemini）继续由 Gate 提供，个人连接仍只允许 Gate。

## 为什么是 Converse 桥

Bedrock 上各家模型支持的接口不一样：Claude 在 Bedrock 上没有 OpenAI Chat Completions 或 Responses 接口，只有 Invoke、Converse 和（bedrock-mantle 上的）Anthropic Messages；GPT-5.4/5.5 反过来没有 Converse。除这两款外，所有热门文本模型都支持 **ConverseStream**，因此它是整个目录唯一共用的协议。目录里的 GPT 用 GPT-5.6/6/6.1，不收录 5.4/5.5。

三个 worker 原本都把模型请求交给一个固定 URL 的 OpenAI 兼容客户端。Bedrock 档案使用同一套 SDK，只是请求不出网，而是交给桥：

```mermaid
flowchart LR
  SDK[Agents SDK / Pi\nOpenAI Chat Completions 请求] --> B[Converse 桥\n固定的合成 URL]
  B -->|ConverseStream 一次| R[bedrock-runtime.REGION.amazonaws.com]
  R -->|事件流| B
  B -->|chat.completion.chunk SSE| SDK
```

- Node：`apps/bedrock-bridge.ts`，Pi worker 与 OpenAI Agents JS worker 共用（AWS SDK 由调用方注入，文件本身不导入任何包）。
- Python：`apps/openai-agents-python-worker/bedrock_bridge.py`，作为 httpx2 transport 接入同一个 `AsyncOpenAI` 客户端。两种实现必须对 `apps/bedrock-bridge-vectors.json` 中的共享向量给出逐字节相同的结果，测试强制这一点。
- 用量、思考字数计数、取消、超时、输出上限、错误码都沿用原有路径：桥输出的是标准 Chat Completions 流，`usage` 来自 Converse 的 `metadata`（缓存读取计入 prompt，且不伪造 total），思考内容只以 `reasoning_content` 交给 worker 计数，永不显示。

桥只做能忠实映射的事，其余一律 400 拒绝，不静默丢弃：远程图片 URL 与非图片的非文本内容、JSON schema 输出、思考强度、采样惩罚、`seed`、logprobs、以 assistant 开头或结尾的对话、不是 JSON 字符串的工具参数。流在没有停止原因时结束视为不完整；未知停止原因、未知事件和未知内容类型（例如 citation）都视为错误，而不是悄悄丢掉。AWS 错误只保留状态码和异常类型，消息里的账号 ID、角色 ARN 不会离开 worker；只有输入超出模型上下文窗口的 `ValidationException`（"Input is too long for requested model"、"prompt is too long" 等，见 `apps/context-overflow.ts`）在 worker 内读一次消息，改报类型 `context_length_exceeded` 和固定消息，AWS 原文照样不离开，worker 据此报 `MODEL_CONTEXT_LIMIT`（托管执行为 `bedrock:400:context_length_exceeded`；只认请求阶段、流开始之前的拒绝，流里的同样错误可能跟在已做的推理之后，仍按模型失败计），API 把这次调用记为未开始、不计次不扣费，运行以 `context_limit` 失败、画布节点不重跑；流开始后才出现的 AWS 错误在错误帧里带上状态码，所以中途限流仍归为 `MODEL_RATE_LIMIT`；桥自己的拒绝（无法转发的内容、不完整的流）不带状态码，不会被当成服务不可用。通往 AWS 的路上断掉、AWS 并没有报出的失败（既没有 AWS 异常名也没有 HTTP 状态码，例如连接被重置、流读到一半断开或无法解码；Node 桥里是本进程自己命名的错误，即套接字、流或计时器的 `Error`、`TypeError`、`AbortError`、`TimeoutError` 等，Python 桥里是并非 AWS 回答（botocore 的 `ClientError`）的错误）类型为 `connection_error`，同样不带状态码（2026-10-25 起）：流开始后这样断掉不算服务不可用，worker 报模型失败（API 显示 `runtime_failed`，画布节点照旧在没有输出时重跑），按一般失败计费，因为 AWS 可能已经做了这部分工作并计了费（`plans.go` 的 `refusedBeforeOutput` 只把立即的拒绝当作没做工作）。AWS 已经回了 HTTP 200、却在第一个事件到来之前断掉的流也一样；对先思考再写的模型，这段时间就是它整个不出声的思考：AWS 的响应头几秒内就到，第一个事件要等模型开始写才到（2026-10-21 的生产探测：按 Pi worker 的请求方式调用 Claude Opus 5.5，响应头 2.3 s，第一个事件 194.9 s，26,500 个输出 token）。AWS 的 JavaScript SDK 要读到第一个事件 `send` 才返回，所以 Node 桥以前在请求阶段遇到这种断开、按 502 当成服务不可用，Pi worker 的这次调用不论模型想了多久都不收费；现在凭 SDK 给它盖上的 200（`$metadata.httpStatusCode`）认出来，同样在 200 里回不带状态码的错误帧。botocore 收到响应头就返回，Python 桥本来就在流里遇到它。AWS 根本没有回答的调用（连接被拒，或在 AWS 的响应头之前断掉）照旧凭响应自身的 502 归为服务不可用：AWS 可能根本没收到这个请求。托管执行里它记为 `stream:error:connection_error`，AWS 没有回答的为 `bedrock:502:connection_error`，API 的归类与此前同一位置的 `api_error` 相同；唯一的变化是 AWS 回了 200、在第一个事件之前断掉的那一种：以前是 `bedrock:502:api_error`（平台故障，退还这次任务的调用），现在和第一个事件之后断掉一样是 `stream:error:connection_error`（不退还）。AWS 报出、桥却不认识的异常（SDK 没有建模、以 AWS 自己的代码为名抛出的流异常，或 botocore 的同类 `EventStreamError`，botocore 给它的错误码为空）仍是 AWS 的失败，照旧为带 502 的 `api_error`。SDK 客户端固定区域端点、`maxAttempts: 1`（一次受理只发一次上游请求）。

桥有意做的适配只有这几项，两种实现一致：

| 请求 | Converse 没有对应能力时桥的做法 |
| --- | --- |
| `parallel_tool_calls: false`（三个 worker 都这样请求） | Converse 没有通用开关，Claude 等模型默认会一次发多个工具调用。桥只转发本轮第一个完整的工具调用并以 `tool_calls` 结束；之后的调用不转发、不执行、也不进入对话历史，模型在下一轮按需再发。用量仍覆盖整轮。`true` 或不写时转发全部调用 |
| 空的工具结果 | Converse 拒绝空白文本块，以 `(empty result)` 送入 |
| user 消息里的图片（`image_url`，2026-10-12 起：让模型直接看懂上传的图片） | 只接受 base64 `data:` URL，格式 png / jpeg / gif / webp，每张解码后不超过 3.75 MiB，每个请求最多 20 张，转成 Converse `image` 块（原始字节），位置与前后文字保持原顺序；远程 URL 从不抓取，直接 400。`detail` 在 Converse 里没有对应项，丢弃，模型按图片本身读取。只有 user 消息可以带图；system、assistant、工具消息里的图片仍 400 |
| 工具的 `strict` | Converse 不保证参数严格符合 schema；worker 执行前仍逐项校验参数，不合格的调用失败而不是执行 |
| `store`、`user`、`metadata`、`prompt_cache_key`、`safety_identifier`、`stream_options` | 只是请求元数据，不改变回答，忽略 |

只走流式对话。托管执行（managed execution，画布助手的直接任务）每次要一次非流式补全：Pi worker 把这一次调用作为一次流式请求发给桥，再把流（文字、按序号拼接的工具调用、结束原因、用量）收拢成一次补全返回（`bedrockComputerRequest` 与 `gatherChatStream`，`apps/computer-model.ts`）；出错帧、未结束的流或 `length` 结束都算失败，不返回半截答案。经 LLM Gate 的 Chat Completions 调用（按 URL 认定，也包括标成 `openai` 的 Gate 条目；标成 `llmgate` 的条目不论 URL 都算，个人的 Gate 连接也算）2026-10-17 起同样以流式发出（带 `stream_options.include_usage`），由同一个 `gatherChatStream` 收拢：Gate 前面的 Cloudflare 会切断约 100 s 不发任何字节的响应，而非流式调用要到最后一个 token 才有输出。隐藏推理（`reasoning_content`）、注释行与空的 `data:` 行（保活）略过、从不转发；Gate 以整体 JSON 回答（200 里的错误，或没有流式）时照旧按整体读。流在结束前被途中关闭时先看关闭前的静默：静默 90 s 以上为 `stream:closed:idle`（与 Cloudflare 切断无输出响应相同），其他关闭为 `stream:closed`；`detail` 说明方式（连接断开时为套接字的代码，如 `UND_ERR_SOCKET`；没有结束原因就结束为 `end`），关闭前的静默只写进 worker 的日志（`quietMs`）；在结束原因之后、没有读到一半的行时连接断开，答案照常返回。`[DONE]` 之后不再读（网关可能在它之后仍挂着连接），`[DONE]` 却没有结束原因为 `stream:unfinished`；Gate 的出错帧（`error`，或以 `code`/`message` 代替 choices 的帧，如审核中断）是它在 200 里的错误，与整体读取时一样记为 `provider:200:<code 或 type>`，因此 Bedrock 的 `stream:error:` 规则不会读到它；流本身出错为 `stream:<detail>`（无法解析 `stream:shape`、`stream:content`、`stream:tool-calls`，未结束的一行超过 1 MiB 或整条流超过上限为 `stream:size`）；流式的拒绝（`delta.refusal`）照整体读取一样以 `answer`/`refusal` 失败、不转发；收拢出的答案与整体读取一样以 512 KiB 为限（`answer`/`size`，Bedrock 也是）；worker 自己等下一个字节超时仍是 `network:UND_ERR_BODY_TIMEOUT`；流开始前的失败照旧（`provider:<status>`、`network:<code>`）。用运营方凭证时，流式调用的中断只有 `stream:closed:idle`（以及 worker 自己的等待超时 `network:UND_ERR_BODY_TIMEOUT`，运营方规则早已退还）按平台一侧退还这次调用，与未流式调用被同一边缘切断（524）相同（额度会话对运营方 2026-10-17 规则的理解）。运营方 2026-10-18 定下：这类途中时间限制的切断（Gate 的 408、边缘的 504/524、`stream:closed:idle`、worker 的 HTTP 头/正文等待超时、Bedrock 调用的 408/504 与模型自己的超时，以及 API 自己的 HTTP 客户端到时限切断的调用）只退被切断的这一次，不退任务的其他调用（任务可以故意拖长一次调用来碰上它）：账本记为 `computer_model_timeout`（失败类别 `timeout`），结算时记进 `refunded_calls`（迁移 039），任务因平台原因结束后退还；其他平台原因的失败照旧退还任务的全部调用（`direct_task_refund.go`）；立即关闭的 `stream:closed` 不退（任务自己的内容可以引起，如审核中断）；在 200 里的 Gate 错误（流的出错帧，或整体读取时 200 里的错误）若写明提供方容量或运营方自己的权限（`overloaded_error`、`rate_limit_error`、`rate_limit_exceeded`、`insufficient_quota`、`insufficient_user_quota`、`permission_error`）退还，与其状态码整体返回时相同，`server_error`、`api_error`、`bad_response_status_code` 与审核代码不退；个人连接的任何流式失败都不退，任务自己一侧放弃的调用仍算切断。Anthropic Messages、Responses 与其他提供方照旧非流式。这次调用和 Bedrock 运行一样在隔离的子进程里做（`apps/pi-worker/bedrock-call.mjs`，`runner.mjs` 的 `bedrockComputerCall`）：不带 Node 参数、只带 `workerEnvironment` 的变量，凭证由父进程解析后经私有 IPC 交给它，worker 自身的环境变量和 Node 参数碰不到 AWS SDK。Converse 要求对话从 user 开始，桥对不是这样开头的请求直接拒绝；而托管执行的引擎每个任务的会话都先放一句自己的问候（系统提示之后是 assistant 的 `Hi, I'm AwwO workspace. What would you like me to do?`，然后才是用户的话）。这样的开头没有提任何要求，所以 worker 发给任何提供方（Bedrock、LLM Gate、Anthropic、Responses）时都把它的文字作为上下文接到系统提示末尾（系统提示仍是一条，有的聊天模板不收第二条），对话从第一条 user 开始（`threadOpening`，`apps/computer-model.ts`；2026-10-17 起不只 Bedrock）；开头里有工具调用或工具结果的不改，仍由桥拒绝。2026-10-12 生产上直接任务用 Bedrock 模型每次都在几十到两百毫秒内失败，原因就是这句问候：桥在发出请求前就拒绝了（改到子进程里调用之后依旧，2026-10-13 查明）。失败只按类别说明原因，不带提供方的原文：回复里的 `error.reason`，如 `bedrock:403:AccessDeniedException`、`stream:error:429:throttlingException`（流开始后 AWS 的失败）、`child-exit:1`；答案不成立时 `reason` 为 `answer`，`error.detail` 说明哪一项检查没过（如 `finish:length`、`finish:content_filter`、`empty`、`tool-name`）。worker 每次拒绝都记一行 `computer_model_rejected` 日志，API 也记一行 `managed model call failed`（2026-10-17 起，取代原来的 `computer_model_bedrock_failed`）。Pi 在 `/health` 上声明 `computerBedrock: true`，API 只在 worker 声明时把它的 Bedrock 模型列入托管执行的模型列表并接受创建；没有声明的 worker（JS 与 Python openai-agents worker）照旧：列表里没有 Bedrock 模型，直接用 API 创建时以 `computer_model_unsupported` 拒绝（不预留调用额度），worker 也会在任何请求离开前以 `MODEL_NOT_SUPPORTED` 拒绝。托管执行能用哪些 Bedrock 模型取决于 Pi 的目录：2026-10-12 起 Pi 的 `AWWO_BEDROCK_MODELS` 加入 `bedrock.claude-opus-5-5`（drop-in `98-assistant-opus.conf`），画布助手因此可以选 Claude Opus 5.5。

## 内置目录

`apps/bedrock-models.json`（`version: 1`）每项：

| 字段 | 含义 |
| --- | --- |
| `id` | AwwO 选择器，`bedrock.` 开头，画布节点保存的就是它 |
| `name` / `vendor` | 显示名与厂商；网页按显示名归入品牌组 |
| `target` | Converse `modelId`：只通过推理配置文件提供的模型用 `global.`/`us.` 配置文件，否则用区域内模型 ID |
| `fallbackTarget` | 可选，目前只有 Claude：同一模型的另一个推理配置文件（`global.` ↔ `us.`）。目标在输出任何内容之前因容量或额度拒绝调用时，桥用它重发一次（见下文 2026-10-19） |
| `reasoningEfforts` / `defaultReasoningEffort` | 可选，只给 Claude：节点可以选的思考强度（`low`、`medium`、`high` 中的若干档，桥把选中的一档作为 Claude 的 `output_config.effort` 发出），以及不选时模型自己的强度（只显示，从不发送）。目前只有 Claude Opus 5.5：`low`/`medium`/`high`，默认 `medium`（见下文 2026-10-26） |
| `contextWindow` / `maxTokens` | AwwO 的保守预算（worker 把 contextWindow 当字节预算），不是厂商上限 |
| `input` | `text`，可含 `image`（仅展示；桥目前只发文本） |
| `tools` | 观察到流式工具调用或文档写明 ConverseStream 支持工具；没有工具能力的模型只放 Pi。Pixtral Large 与 Llama 只在非流式 Converse 接受工具（ConverseStream 回答 “This model doesn't support tool use in streaming mode”），所以放 Pi |
| `runtime` | 默认归属：有工具能力的放 `openai-agents`（含项目执行），其余放 `pi`，每个模型默认只出现一次 |
| `verified` | 经 AwwO worker 在本账号真实调用成功的日期；空值表示尚未开放（目前是 Marketplace 订阅被拒的 8 个），`builtin` 模式不提供这些模型 |

目录顶层的 `regions` 记录这些条目核对过的区域（目前只有 `us-east-1`）：模型 ID 和推理配置文件因区域而异，`AWWO_BEDROCK_REGION` 不在其中时内置目录直接拒绝启动，其他区域请先核对，再用 `*_MODELS_JSON` 写明确的档案。目录在每个 worker 启动时严格校验，格式错误直接拒绝启动。模型会下线或改名：修改目录前先只读核对账号可见的模型（不产生推理费用）：

```sh
python scripts/bedrock-catalog-check.py --region us-east-1 --profile <aws-profile>
```

2026-10-03 结果：us-east-1 目录 0 项需处理；us-east-2 缺 `qwen.qwen3-coder-next`，因此目录只声明 us-east-1，默认区域也是 us-east-1（跨区域配置文件本身会路由，生产主机在 us-east-2 不影响）。

## 配置

每个 worker 读自己的环境（变量名相同）：

| 变量 | 说明 |
| --- | --- |
| `AWWO_BEDROCK_CATALOG` | 空/`off`（默认）不加任何 Bedrock 模型；`builtin` 加入内置目录中**已用真实调用核验过**的模型；`builtin-all` 再加入需要跨区域推理权限、尚未核验的模型（Claude、GPT-6、Grok、Kimi K3、Llama、Nova 等），在实例角色获得权限并核验后再用 |
| `AWWO_BEDROCK_REGION` | Bedrock 运行时区域，默认 `us-east-1`；只接受商业区域白名单。内置目录只在它的 `regions` 内可用，`*_MODELS_JSON` 档案可用任意白名单区域 |
| `AWWO_BEDROCK_MODELS` | 空：上一项模式提供的、默认归属本 worker 的模型；否则为逗号分隔的目录 ID（按目录顺序生效，明确列出即视为运营方确认可调用，含未核验模型）。OpenAI Agents worker 拒绝没有工具能力的模型，Pi 可以承载任何目录模型 |
| `AWWO_BEDROCK_API_KEY` | 可选 Bedrock API Key。留空时用 worker 自己的 AWS 凭证链签名（EC2 实例角色），不在文件里保存长期密钥 |
| `AWWO_BEDROCK_PROMPT_CACHE_MODELS` | 空（默认）：请求与以前完全相同。逗号分隔的目录 ID：只对这些 Claude 目录模型启用显式提示缓存——带历史的对话或工具循环（多于一条消息）在工具定义后、系统提示后、最后一条消息末尾各加一个 `cachePoint`（默认 5 分钟 TTL），单条消息的请求不变。点名的必须是本 worker 从内置目录提供的 Anthropic 模型，否则 worker 拒绝启动。价格不变：用量仍把缓存读写都计入 prompt tokens。三个 worker（Pi、JS、Python）各读自己的环境；计费取舍见 `docs/awwo-cost-and-abuse-review.md` |
| `AWWO_PLATFORM_PROVIDERS` | `AWWO_LLMGATE_ONLY=true` 时允许的运营方目标，默认 `llmgate`；要启用 Bedrock 设为 `llmgate,bedrock`，再加 `deepseek` 允许 DeepSeek API 档案（见 `docs/awwo-deepseek.md`）。规范顺序为 `llmgate,bedrock,deepseek`。**API 与 worker 都要设置** |

也可以在 `*_MODELS_JSON` 里写单个 Bedrock 档案，不带 URL、协议、思考强度或结构化输出：

```json
[{"id":"bedrock-kimi","name":"Kimi K2.5","provider":"bedrock","model":"moonshotai.kimi-k2.5","region":"us-east-1"}]
```

`apiKeyEnv` 可选；不写就用 AWS 凭证链。Compose 用 `AWWO_PI_BEDROCK_MODELS` / `AWWO_OPENAI_AGENTS_BEDROCK_MODELS` 分别给两个 worker 选模型；本地 `npm run dev:saas` 同样把 Bedrock 设置只发给 worker，Bedrock Key 不会进入 API 或网页进程。

### Gate-only 模式的平台策略

生产是 `AWWO_CREDENTIAL_MODE=operator` + `AWWO_LLMGATE_ONLY=true`。健康信息声明的是 worker 的模型**实际**到达的目标，而不是策略允许的范围：没有 Bedrock 模型的 worker 仍上报原来的 `llmgateOnly: true`，健康信息逐字节不变（即使策略里写了 `bedrock`）；提供 Bedrock 模型时如实上报 `platformOnly: true, platformProviders: ["llmgate","bedrock"]`，不会再声称"只走 Gate"。API 只在以下情况接受 worker：原样的 Gate-only 声明且没有 Bedrock 或 DeepSeek 模型；或规范顺序的平台列表，且其中每一项都在 API 自己的 `AWWO_PLATFORM_PROVIDERS` 里，有 Bedrock 模型时列表必须含 `bedrock`，有 DeepSeek 模型时必须含 `deepseek`。Bedrock 用的是运营方凭证：`AWWO_CREDENTIAL_MODE=user` 的 worker 配了 Bedrock 模型会直接拒绝启动，个人连接仍只能用 LLM Gate（DeepSeek 同理）。

**部署顺序**：先部署能识别平台声明的 API，再给 worker 打开 Bedrock；只部署新 worker 而不打开 Bedrock 时，worker 仍是 Gate-only，旧 API 也能正常使用。

## 凭证与 IAM（运营方选择：EC2 实例角色）

2026-10-03 起，生产实例改用 AwwO 专用的实例配置文件 `awwo-saas-instance`（原来的 `dongfeng-demo-ssm` 被多台实例共用，不再使用）：`AmazonSSMManagedInstanceCore` 加两条内联策略，都只允许 `bedrock:InvokeModel` 与 `InvokeModelWithResponseStream`。`awwo-bedrock-verified-models` 列出 23 个 us-east-1 区域内基础模型；`awwo-bedrock-cross-region-profiles`（2026-10-04）列出 27 个推理配置文件，以及账号 `ListInferenceProfiles` 报告的、每个配置文件实际路由到的基础模型 ARN（`global.` 为不带区域的 ARN 加 us-east-1，`us.` 为 us-east-1/us-east-2/us-west-2），一共 88 个资源，不用通配。下面是按通配写的宽策略，只作参考（把账号与区域换成实际值）：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AwwOBedrockInference",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:::foundation-model/*",
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*"
      ]
    },
    {
      "Sid": "AwwOBedrockMarketplaceFirstUse",
      "Effect": "Allow",
      "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
      "Resource": "*"
    }
  ]
}
```

- 跨区域推理是必需的：Claude、GPT-5.6/6.x、Grok、Kimi K3、Llama 4、Nova 等**只能**通过 `global.`/`us.` 推理配置文件调用，配置文件会路由到其他区域（`global.` 的模型 ARN 不带区域），所以策略必须同时允许配置文件与各区域的基础模型。若组织 SCP 限制区域，需要放开相应区域或只用 `us.` 配置文件。
- 2026-10-03 用 PlatformEngineer SSO 角色实测：区域内模型全部可调用，所有推理配置文件目标均被拒绝（该角色只允许区域内基础模型）。2026-10-04 实例角色加上跨区域策略后，这些配置文件都能调用，只有 Marketplace 订阅失败的模型除外。
- 第三方模型要有 Marketplace 订阅（协议）。`aws bedrock get-foundation-model-availability` 的 `agreementAvailability` 为 `AVAILABLE` 才算订好；为 `NOT_AVAILABLE` 时，用 `ListFoundationModelAgreementOffers` 与 `CreateFoundationModelAgreement` 接受公开报价（按量计费，不退款）。2026-10-04 为 Claude Sonnet 5.5 与 7 个 GPT 接受了报价，但 Marketplace 在约 12 秒内终止了协议，调用报 `INVALID_PAYMENT_INSTRUMENT: A valid payment instrument must be provided`：账号要有可用于 Marketplace 购买的有效付款方式。订阅处于中间状态时，个别调用可能短暂成功，随后又被拒，所以要以协议状态和实例角色的真实调用为准。实例角色没有 `aws-marketplace:*` 权限，不会自己去订阅。
- worker 父进程读取凭证链；子进程整轮运行都用启动时拿到的凭证（最长 600 s 超时加 10 s 宽限），所以剩余有效期不足 15 分钟时父进程就让凭证链强制刷新（凭证源暂时给不出新凭证时每分钟最多再问一次；刷新失败而现有凭证仍有至少 1 分钟时继续用现有凭证）。子进程只通过私有 IPC 收到短期凭证或 API Key，从不自己读凭证链。Python worker 进程内直接使用 boto3 凭证链（botocore 自动刷新），并按区域、Key 和超时复用客户端（连接池 32）；凭证链暂时取不到凭证时不缓存客户端、本次报 `MODEL_AUTHENTICATION`，下次调用重新解析。

### 凭证边界（启用前必读）

实例角色的凭证来自 IMDS（169.254.169.254），**主机上任何进程都能取到**，不只是 worker：API、nginx 后面的服务、worker 启动的子进程都一样。给角色加上 Bedrock 权限，也就让这些进程在被攻破时可以调用 Bedrock（主要风险是费用滥用）。启用前至少做一项：

1. **只让 worker 访问 IMDS**（推荐，保持无静态密钥）：原生 systemd 部署给除三个 worker 外的每个 AwwO 单元加 `IPAddressDeny=169.254.169.254/32`，例如 `systemctl set-property awwo-saas-api IPAddressDeny=169.254.169.254/32`：立即作用于运行中的单元，持久写在 `/etc/systemd/system.control/`，重启后仍有效。生产（2026-10-03）对 API、web、TypeSafe、数据库、cloudflared、OpenMaus 与两个 acceptance 单元这样做了。不要用 `iptables -m cgroup --path`：这条规则绑定的是创建规则时那个 cgroup 对象，单元重启会建出新的 cgroup，放行就静默失效。同一 uid 的服务也无法靠 `--uid-owner` 区分。
2. **或改用 Bedrock API Key**：只写进 worker 的环境文件（root 所有、0600，经 systemd `EnvironmentFile` 载入），实例角色不加 Bedrock 权限。
3. **Compose**：保持 IMDS hop limit 为 1（容器经网桥多一跳，取不到实例凭证），给两个 worker 容器配 `AWWO_BEDROCK_API_KEY`；API 容器不会收到这个变量。

无论哪种方式，都建议把策略的 `foundation-model/*` 收窄到目录里实际使用的模型，并在 AWS Budgets 设 Bedrock 费用告警。本地 `npm run dev:saas` 只把环境里的 `AWS_*` 与 Bedrock 设置交给两个 worker，API、网页与构建进程收不到。

Python worker 从仓库或发布树（`apps/openai-agents-python-worker`）运行，目录文件在上一级 `apps/bedrock-models.json`；若以非 editable 方式安装，需要把该文件复制到模块旁边，否则开启目录时 worker 会明确报错拒绝启动。

## 生产启用清单

1. IAM：为 AwwO 实例角色附加上述策略，并先按“凭证边界”限制 IMDS（运营方操作）。
2. 发布包含本变更的 API 与三个 worker（Python worker 的 venv 需安装 `boto3==1.43.75`），先 API 后 worker。
3. API 环境：`AWWO_PLATFORM_PROVIDERS=llmgate,bedrock`。
4. worker 环境（Pi、JS、Python 各自的 env 文件）：`AWWO_BEDROCK_CATALOG=builtin`（只开已核验的模型，2026-10-04 起 42 个；2026-10-07 下架 Fable 后 40 个）、`AWWO_PLATFORM_PROVIDERS=llmgate,bedrock`，可选 `AWWO_BEDROCK_REGION`、`AWWO_BEDROCK_MODELS`。实例角色获得跨区域推理权限后，对 Claude、GPT 等各做一次冒烟，再改为 `builtin-all`（或在 `AWWO_BEDROCK_MODELS` 中逐个列出），并把核验日期写回目录的 `verified`。
5. 读回每个 worker 的 `/health`：`platformOnly: true`、模型列表含 `bedrock.*`，且不含任何 URL 或密钥。
6. **工作区模型权限**：新工作区按 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 写入 `tenants.allowed_models`。2026-10-05 起现网新工作区的 GPT 与 Claude 走 LLM Gate；Gate 没有的 Claude Opus 5.5 走 Bedrock（`bedrock.claude-opus-5-5`，只在 OpenAI Agents 运行时；Fable 5.1 已于 2026-10-07 下架），其余 Bedrock 模型只出现在没有白名单的旧工作区（见下方「2026-10-05 渠道选择」）。2026-10-07 起免费层的路由额度为 `gate=0,bedrock=0,media=1`：白名单里的高级模型只对付费套餐开放。开放哪些模型（Opus 等高价模型的成本）由运营方决定，单个工作区用管理端 `PATCH /api/v1/admin/tenants/{id}` 调整。
7. 用一个测试工作区对一到两个模型做真实冒烟（不在生产创建测试画布时可用 shadow-plan 流程）。

## 限制

- 思考强度：Bedrock 档案目前不宣告任何档位，桥拒绝 `reasoning_effort`。Claude 与 GPT 的映射需要在实例角色获得权限后真实验证再开放。
- 结构化输出：不宣告 `structuredOutput`，节点交付契约走文本路径。
- 只发文本；图像输入、文件附件不经过桥。
- Pixtral Large 与 Llama 不调用工具：Bedrock 不在流式模式下为它们提供工具，所以它们在 Pi 上作为纯对话模型提供。
- 托管执行只在声明 `computerBedrock` 的 worker（Pi）上使用 Bedrock 模型，且只限该 worker 目录里的模型（见上文）。
- 计费走 AWS 账单；`AWWO_MODEL_PRICING_JSON` 未加入 Bedrock 价格，用量估算显示为未知。

## 验收记录（2026-10-03，本机 WSL，真实 Bedrock，us-east-1）

真实 worker 进程（Node 24.21 / Python 3.12，openai-agents 0.22.3）经桥调用：

| Worker | 模型 | 结果 |
| --- | --- | --- |
| JS | DeepSeek V3.2、GLM-5、Kimi K2.5、Qwen3 Coder Next、MiniMax M2.5、Mistral Large 3、Nemotron 3 Super、gpt-oss-120b | 全部完成，usage 为 reported；MiniMax 与 gpt-oss 的思考只计数 |
| JS | DeepSeek V3.2、GLM-5 + calculator | 工具调用一次，结果 `{"value":66}` 即 (17+5)×3 |
| JS / Python | GLM-5 多轮历史 | 正确复述上一轮的“青色” |
| Python | DeepSeek V3.2、GLM-5、Kimi K2 Thinking；两次工具调用 | 全部完成 |
| Pi | Gemma 3 27B、GLM-5、Kimi K2 Thinking | 全部完成，思考只计数 |

首次实测发现并修复一个缺陷：可读流的 `pull()` 若一次没有产出数据块（推理签名、块结束等事件），在读者已等待时不会再被调用，导致带推理或工具调用的流挂到 120 s 超时。修复后对应回归测试在去掉修复时会复现挂起。

自动测试：桥与目录单测 26 项、JS worker Bedrock 集成 10 项（官方 Agents SDK 端到端、工具、一次两个工具调用只执行第一个、错误码、中途限流、子进程凭证传递）、项目执行在凭证失败后仍可用、托管执行拒绝 Bedrock、Python 17 项（含与 TS 的向量一致性：9 个请求、30 个拒绝、7 个流、12 个流错误）、Go 平台策略 54 种声明组合与托管执行模型列表、网页目录分组（全部 50 个目录模型归入正确品牌）。

安全复核（2026-10-03，独立 reviewer 子代理）提出 10 项，均已处理：凭证失败曾让整个 worker 关闭项目执行；`parallel_tool_calls: false` 曾被忽略；托管执行曾把 Bedrock 模型发往桥不服务的路径；健康声明曾取自策略而非实际模型；内置目录曾可在未核对的区域启用；凭证刷新余量短于一轮运行；`seed`、对象形式的工具参数、未知流事件曾被静默忽略；中途错误曾丢失状态码；Python 每次调用都新建 boto3 会话。第 10 项（`qwen3.8-27b-p6` 从「ClawHunt · 平台模型」移到「通义千问 Qwen」组）是有意的界面变化，待运营方确认。复核第二轮又发现并修复：Python 客户端缓存会把一次凭证链失败固化成持续故障（阻断项）；桥自己的拒绝被归为服务不可用；关闭目录时仍读取目录文件；直接 API 创建托管执行时未拒绝 Bedrock 模型；compose 示例未提示必须是运营方模式；连接池小于并发；测试读取了本机真实凭证链。

## 验收记录（2026-10-04，生产主机，实例角色，真实 Bedrock）

在生产主机上用发布 `8c245632` 的 worker 代码起临时 worker（transient unit，awwo-saas 用户，18097/18098/18099 端口，随机 token，载入正式单元的环境文件，加 `AWWO_BEDROCK_CATALOG=builtin-all`），凭证就是生产实例角色。正式 worker 和数据库都没碰：

| 路径 | 模型 | 结果 |
| --- | --- | --- |
| Python + calculator（生产 openai-agents 路径） | Claude Opus 5.5、Fable 5.1、Opus 5、Sonnet 5、Fable 5、Opus 4.8、Sonnet 4.6、Haiku 4.5，Grok 4.7、4.6，Kimi K3，Nova 2 Lite、Pro、Micro | 全部完成，工具调用一次，结果 `{"value": 391.0}`（17×23；runner 的 `stop_on_first_tool` 把工具结果作为答案） |
| Python + calculator | Pixtral Large、Llama 4 Maverick、Llama 4 Scout、Llama 3.3 70B | 被拒：ConverseStream 不支持这些模型流式调用工具；非流式 Converse 带工具可用，流式不带工具可用 |
| JS，不带工具 | 上面 4 个，以及 Haiku 4.5、Nova Micro、Llama 3.3 70B | 全部完成；这 4 个改为 `tools: false`、放 Pi |
| Pi | DeepSeek R1 | 完成 |
| Python + calculator | GPT-6.1 Sol、6 Sol、6 Astra、6 Luna、5.6 Sol、5.6 Terra | 当时完成，随后同一角色调用 5.6 Terra 被拒（要求 `aws-marketplace:Subscribe`）：订阅没有建立，不开放 |
| Python | Claude Sonnet 5.5、GPT-5.6 Luna | `INVALID_PAYMENT_INSTRUMENT`，不开放 |

目录据此把 19 个模型的 `verified` 记为 2026-10-04，`builtin` 共 42 个；Claude Sonnet 5.5 与 7 个 GPT 留空，等账号补上付款方式、订阅成功后再按同样方式验收。

## 2026-10-05 渠道选择：新用户的 GPT 与 Claude 走 LLM Gate

需求：新用户登录后能用 GPT、Claude 全系列和 RunningHub 生图生视频，全部走一个能走通的渠道。三条路都实测过（生产主机，运营方凭证）：

| 渠道 | GPT | Claude | 结论 |
| --- | --- | --- | --- |
| Bedrock | 7 个 GPT 与 Sonnet 5.5 的 Marketplace 协议仍是 `ERROR`（付款方式无效，需要账号所有者在 Billing 里补付款方式），gpt-5.4/5.5 没有协议 | Opus 5.5、Fable 5.1 等 8 个可用 | 走不通 GPT |
| Kiro（kiro-cli） | 列出 GPT-5.6 Sol/Terra/Luna | 列出全系列含 5.5 | 不是多租户 API：运营方个人的 IAM Identity Center 席位、按月 10000 credits（当月已用 101%），是 agent CLI，没有图像/视频 |
| **LLM Gate** | gpt-5.5、gpt-5.6-sol、gpt-5.6-terra：Chat Completions 带工具、流式、Responses 都通过；gpt-5.4 列在 `/v1/models` 但无通道（503），gpt-5.6-luna 无通道 | Opus 5 / 4.8 / 4.7 / 4.6、Sonnet 5 / 4.6、Fable 5、Haiku 4.5，带工具与流式都通过；没有 5.5 一代 | **选用** |

经 AwwO 自己的 worker 代码（临时 worker，载入正式环境与目录）验证：Python worker（节点执行路径，带 calculator 工具）上 3 个 GPT 与 8 个 Claude 全部完成，gpt-5.4 为 `MODEL_UNAVAILABLE`；Pi worker（规划路径）上 GPT 与 Claude 完成。Gate 接受约 7.6 万 token 的输入与 `max_tokens` 32000，Claude Sonnet 5 一次写出 6138 token；一次真实建页（4096 输出上限）GPT 的隐藏推理只用 76–885 token，均正常结束，但 GPT 写满 4000 token 约需 80–90 s，接近 Python worker 默认的 120 s 单节点时限。Gate 的 Claude 自我介绍为「AI-powered development environment」，说明其上游通道带有自己的系统提示词。

于是 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 从 `qwen3.8-27b-p6` 改为 30 个 id：`qwen3.8-27b-p6`（默认与规划模型不变）、上述 3 个 GPT、8 个 Claude、全部 18 个 `rh.*`；gpt-5.4 与所有 `bedrock.*` 不在其中。仍停在旧默认 `{qwen3.8-27b-p6}` 的工作区（当时 1 个）按管理端 PATCH 的写法改为新列表并写审计记录。部署前用影子检查证明：新注册用户的 `/runtime` 恰好是这 12 个文本模型、`/media` 是 18 个媒体模型，GPT/Claude 节点在两种运行时都完成，图像与视频（含 Seedance 2.0）生成后可内联播放，`bedrock.claude-opus-5-5` 与 `gpt-5.4` 在节点初始化时被拒。部署记录见 `docs/awwo-saas-deploy.md`。

### 同日后续：运营方的取舍

运营方随后决定删掉 gpt-5.4、加上 Opus 5.5，其余按最佳判断处理：

- **gpt-5.4 下架**：三个 worker 的 `95-model-catalog.env` 都删去该条（当时生产里 0 个 Agent、0 个画布节点用它）。
- **Gate 的 GPT 与 Claude 放宽上限**：11 个条目从 32,768 / 4,096 改为 131,072 / 16,384（与默认模型在 JS、Pi 上的配置一致），Python worker 的单节点时限 `AWWO_OPENAI_AGENTS_TIMEOUT_MS` 从默认 120 s 改为 600 s（Pi 同值）。证据：经影子 API、正式 Python worker 与 Gate，gpt-5.5 一个节点写出 59,125 字符、385 s 完成；改前会在 4,096 token 或 120 s 处失败。
- **新用户加入 Claude Opus 5.5 与 Fable 5.1**（Bedrock，`AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 增至 32 个 id，已有的同列表工作区一并更新）。Claude Sonnet 5.5 仍因 Marketplace 付款方式无法开通。
- **Opus 5.5 改走 US 推理配置文件**：当天它的 global 配置文件对实例角色和管理员角色都答 `ServiceUnavailableException`（管理员连续 8/8），`us.anthropic.claude-opus-5-5` 8/8 在 1–3 s 内正常；目录目标改为 `us.`，实例角色的内联策略 `awwo-bedrock-cross-region-profiles` 加入该配置文件及其 us-east-2、us-west-2 目标（us-east-1 原已允许），worker 按目录单独发布 `ca2bd944`。其他 Claude 仍走 global。

## 2026-10-07：下架 Fable，Opus 5.5 改回 global（AWS 架构建议）

- **Fable 5 与 5.1 下架**：Bedrock 对 Fable 的全部流量保留最长 30 天，并对分类器标记的内容做人工审阅（模型卡要求账号使用 `aws_review` 数据保留设置）；用户内容不接受这种处理，AWS 顾问也建议下架。目录删去两项（48 项，40 个已核验），新工作区白名单去掉 `bedrock.claude-fable-5-1` 与 Gate 的 `claude-fable-5`（32 → 30 个 id），已有白名单里的 Fable 一并删除（审计记录各一条）。下架前生产里 0 个 Agent、0 个画布引用 Fable。
- **Opus 5.5 改回 `global.anthropic.claude-opus-5-5`**：AWS 建议推理配置文件统一用 global、不用 us.；当天实例角色对 global 8/8 成功（约 1.3 s），10-05 的 `ServiceUnavailableException` 已消失。实例角色的内联策略原本就允许该 global 配置文件；us. 的授权保留，作回退。其余 7 个 `us.` 目标（DeepSeek R1、Pixtral Large、Llama 3 个、Nova Pro、Nova Micro）在账号里没有 global 配置文件，保持不变。
- **免费层**：新工作区与 6 个已有免费工作区的路由额度改为 `gate=0,bedrock=0,media=1`（免费层只用默认模型和每天 1 次媒体）；付费套餐按点数使用 Claude / GPT / Bedrock，不受影响。

## 数据留存、人工审阅与训练（2026-10-07 按 AWS 文档核对，供 AWS 逐项确认）

AWS 顾问要求上线前逐一确认已开放模型的数据政策。以下来自 AWS 一手文档（Bedrock 用户指南的 abuse-detection、data-retention、data-protection、cross-region-inference 页、Bedrock FAQ、AWS 服务条款 §50、第三方模型条款），2026-10-07 读取：

- **默认（下列例外以外的全部 40 个模型）**：Bedrock 默认不存储输入与输出；不提供给模型方（模型运行在模型方无权访问的 AWS 账号里，AWS 只与模型方共享不含客户内容的用量数据）；AWS 与模型方都不用这些输入输出训练模型。人工审阅仅限疑似儿童性虐待内容（CSAM）。Anthropic 与 xAI 的条款另外写明不用客户内容训练。
- **推理配置文件的处理地域**：`us.` 只在美国区域处理；`global.` 可能被路由到任一商业区域处理。留存的数据（如有）存放在实际处理请求的目标区域，不是发起区域（AWS data-retention 页：跨区域推理时，留存的输入输出存放在处理请求的区域；2026-10-09 更正，原文误写为“只在发起区域”）。账号设置按发起区域生效，本账号三个美国区域的控制面自 2026-10-07 14:51Z 起为 `none`，此时需要留存的模型会被 Bedrock 直接拒绝，能应答的模型不留存。我们的隐私条款写明服务运行在 AWS 美国、模型方可能在其他国家处理请求，覆盖这一点。
- **例外**：Claude Fable 5 / 5.1 对全部流量留存最长 30 天并对分类器标记内容做 AWS 人工审阅（模型卡要求账号使用 `aws_review` 留存设置）——已于 2026-10-07 下架。OpenAI 自有的 GPT-5.4 至 GPT-6 系列对标记流量留存最长 30 天：目前不在开放列表里（Marketplace 付款问题），开放前要先评估；Sonnet 5.5 与 GPT-6.1 Sol 不在例外列表上，留存情况待 AWS 确认。OpenAI 的 Bedrock 协议 §2.3 还限制向第三方提供「开放式或自动化的编码能力」，开放 GPT 前一并确认。
- **账号留存设置**：Fable 能被调用，说明 us-east-1 的留存设置很可能是 `aws_review`。下架 Fable 后可以把它设为 `none`（零留存），Bedrock 会拒绝任何需要留存的模型，从而证明剩余模型都不留存；但这是账号级设置，研发在同一账号里自用的 Fable 5 也会被拒，需要运营方决定。该设置不跨区域传播。
- **请 AWS 确认**：① 本账号 us-east-1 的当前留存设置，以及 2026-10-05 到 10-07 生产发往 Fable 5.1 的流量保存在哪、保存多久；② 40 个模型是否都允许 `none`；③ us-east-1 的设置是否覆盖被 `global.` / `us.` 路由到其他区域的调用；④ Bedrock 的提示缓存（最长 1 小时，Kimi K3 至少 30 分钟）是否算存储；⑤ Anthropic 是否从不接收 Claude 内容；⑥ 非例外模型的滥用检测具体检查并保留什么。


## 2026-10-07 晚：零留存已生效；前沿模型被拒与零留存无关

- **零留存有两个设置**：AWS 文档写明，`bedrock-runtime`（我们的 Converse 桥走这条）的留存模式由**控制面**的账号设置决定（`aws bedrock get-/put-account-data-retention`），`bedrock-mantle` 端点的 `PUT /v1/data_retention` 只管 Messages / Chat Completions / Responses 接口。两者分开存储。
  - 11:44Z（业主决定零留存，「我不用 fable」）只改了 mantle：us-east-1、us-east-2、us-west-2 从 `inherit` 设为 `none`。控制面没动：us-east-1 仍是 `provider_data_share`（2026-08-21 起），us-east-2、us-west-2 是 `inherit`。所以 11:45Z 经 Converse 调用 Fable 仍有应答，上文「很可能是 `aws_review`」实际是 `provider_data_share`。
  - 14:51Z 把控制面的三个美国区域都设为 `none`，读回均为 `none`。改回：`aws bedrock put-account-data-retention --mode provider_data_share --region us-east-1`（us-east-2、us-west-2 用 `--mode inherit`），mantle 用 `PUT {"mode":"inherit"}`，都立即可逆。
  - 同时（11:46Z）从实例角色的 `awwo-bedrock-cross-region-profiles` 删去 6 个 Fable 资源（91 → 85）。
- **前沿模型被拒**：约 12:09Z 起，Claude Opus 5.5、Opus 5、Sonnet 5、Opus 4.8，Grok 4.7、4.6 返回 `AccessDeniedException: … is not available for this account … contact AWS Sales`。这发生在控制面仍是最宽松的 `provider_data_share` 的时候：14:4xZ 在 us-east-1 对 40 个已核验模型各发一次 8-token 调用，33 个应答，被拒的正是这 6 个（Kimi K3 是探针的 maxTokens 低于它的下限）；Opus 5.5 在 eu-west-1（未设置）也被拒得一模一样；`GetFoundationModelAvailability` 对 Opus 5.5、Sonnet 5 仍报 `AUTHORIZED` / `AVAILABLE`。AWS 文档列出的需要留存的模型只有 Fable 5 / 5.1 与 GPT-5.4 至 GPT-6 系列。结论：**拒绝来自账号层面的模型访问，与零留存无关**，改回留存设置不会恢复。设为 `none` 后立即复测，应答的仍是同样的 33 个。
- **请 AWS 确认**（接上面的列表）：⑦ 本账号自 2026-10-07 12:09Z 起调用 Opus 5.5 等前沿模型返回 “not available for this account”，而可用性接口仍报已授权，原因是什么、怎样恢复；⑧ 零留存下 40 个已核验模型是否都可调用（14:51Z 设置后复测 33 个应答，与设置前相同）。

## 2026-10-18：Python worker 单次运行时限 25 分钟

- **起因**：一位活动用户的画布节点（Claude Opus 5.5）在 600 s 时以 `run_timeout` 失败，第一段文字还没出来就到了 Python worker 自己的时限（`AWWO_OPENAI_AGENTS_TIMEOUT_MS=600000`；代码上限当时也是 600 s）。同日 7b495004 让 Opus 5.5 每次调用可写 64,000 个输出 token，思考久的调用更需要时间。
- **改动**：代码上限放宽到 1,800,000 ms（与 JS worker 相同）；现网 env 改为 1,500,000（25 分钟），比 API 的 30 分钟运行时限早结束，留出收尾与计费的时间。OpenAI 客户端的超时跟随这个时限（连接超时仍是 5 s）；SDK 的超时异常 `APITimeoutError` 记为 `DEADLINE_EXCEEDED`（API 显示为 `run_timeout`），连接阶段的除外（见下）。
- **代价**：一个完不成的节点最长占 25 分钟。超时的节点不再自动重试（运营方 10-18「超时不再重试」，`graph_retry.go`）：此前 21 天的 17 次 `run_timeout` 都用满了时限（600 s 以上），R-1 重跑过其中 5 次，重跑只会再等一遍、再计一次费。连接阶段的 5 s 超时没有到达模型服务，记为 `MODEL_UNAVAILABLE`（API 显示为 `provider_unavailable`），仍可自动重试，很快结束的不计费。被截断、没有输出的调用按隐藏推理估算计费，上限 65,536 token（`plans.go` 的 `maxHiddenTokens`，与目录的 `MAX_OUTPUT_TOKENS` 相同），按每秒 120 token 约 9 分钟就到上限，所以时限变长不会让单次估算更高。
- **回滚**：旧代码不接受 1,500,000（启动即失败），回滚代码时 env 必须一起改回 600000；发布脚本两者一起切换、一起回滚。

## 2026-10-19：Claude 的 global 与 US 推理配置文件互为备选

- **起因**（运营方 10-19「线上如果claude global区域的无法访问就用us区域的，互相作为备选」）：当天上午 CloudTrail 记下 worker 的 IAM 用户 `machine/awwo-tokyo-runtime` 调 `global.anthropic.claude-haiku-4-5-20251001-v1:0` 有 17 次 `ServiceUnavailableException`（02:07–02:18Z 11 次，03:51、04:39、05:26Z 各有几次），对应 17 个失败的规划与助手运行；02:31–02:32Z `global.anthropic.claude-opus-5-5` 有 3 次 `ThrottlingException: Too many tokens per day`。同一时刻账号里的另一个 Bedrock API Key（开发用的 Claude Code，CloudTrail 用户名 `MantleApiKey-…`）在 global Opus 5.5 上也被这样拒绝，换到 `us.` 后正常：global 的每日 token 额度是全账号共用的，US 配置文件另有自己的额度。
- **IAM**：`awwo-tokyo-runtime-bedrock-profiles` 与 `awwo-tokyo-runtime-bedrock-via-profile` 两个托管策略升到 v4（v3 留作回滚）：加上目录里 Claude 模型的 `us.anthropic.*` 推理配置文件，以及这些模型在 us-east-2、us-west-2 的基础模型（`us.` 配置文件路由到 us-east-1/us-east-2/us-west-2，us-east-1 原本就有）。主机 IP 条件与"只能经本账号推理配置文件调用"的条件不变。改后从主机用 worker 的凭证逐个实测：6 个 Claude 模型的 `us.` 与 `global.` 都能调用（Sonnet 5.5 仍是 Marketplace 付款问题）；测试时 `global.anthropic.claude-sonnet-5` 正好答 `ServiceUnavailableException`，`us.` 正常。
- **行为**：目录的 `fallbackTarget` 经 worker 档案（`fallbackModel` / `fallback_model`）交给桥。桥在第一个配置文件拒绝调用时（请求本身被拒，或流的第一个事件就是异常），若异常是 `ThrottlingException`、`ServiceUnavailableException`、`InternalServerException`、`ModelNotReadyException` 或 `ServiceQuotaExceededException`，在同一个客户端上把同一请求发给另一个配置文件，只发一次。流已经输出过内容、其他错误（权限、参数、模型超时等）、或备选也失败时，都不再重试，调用照旧失败。没有 `fallbackTarget` 的模型完全按原来的方式调用（不预读第一个事件）。返回给调用方的 chunk 仍写原来的模型 ID；`model_invocations.provider_model` 记的仍是目录的 `target`。
- **日志**：每次换用备选写一行 `bedrock_profile_fallback`（from、to、after），每次失败的 Bedrock 调用写一行 `bedrock_call_failed`（model、error、status、stage = request 或 stream、upstream = true 表示 AWS 的回答或通往它的路上出的错（含网络、凭证），false 表示桥自己拒绝：请求或内容无法转换），只有模型 ID、错误名和状态码，不含提示词、回答或 AWS 消息。Pi 与 JS worker 由子进程经 IPC 报给父进程再写（子进程本身没有输出），Python worker 直接写 stderr。此前 Pi worker 的规划运行失败时日志里看不到 AWS 异常名，这次一并补上。
- **计费**：用户按目录 id 计点数，换用 US 不改变用户的费用；AWS 按 US 配置文件的价格向账号收费，可能与 global 不同。被拒绝的那次请求没有处理任何 token（Bedrock 按 token 计费）。
- **回滚**：去掉目录里的 `fallbackTarget` 或回滚 worker 发布即可停用；IAM 可把两个策略的默认版本设回 v3。

## 2026-10-19：Python worker 的 Bedrock 流 15 分钟无字节即失败

- **起因**（运营方 10-19「第4条做吧」）：05:19–07:37Z 同一张画布的 5 个 Opus 5.5 节点在 Python worker 上各只发出一次调用，整整 25 分钟没有任何返回（没有用量；CloudTrail 只记到调用开始，之后没有别的调用），提示词 2–14 KB；同样的节点重跑 64–164 s 就完成。Python 桥的 botocore 读超时等于运行时限（1,500 s），一次停滞的调用就用掉整个运行，以 `run_timeout` 结束，不再自动重试。
- **改动**：botocore 的读超时改为流的空闲上限 15 分钟（与 JS 桥的 `BEDROCK_STREAM_IDLE_MS` 相同；运行时限更短时仍用运行时限，`stream_read_timeout`）。连续 15 分钟收不到一个字节，桥报 504 `ReadTimeoutError`（等响应时是 botocore 的，流已开始后是 urllib3 的），worker 记为 `MODEL_UNAVAILABLE`（API 显示 `provider_unavailable`），画布节点只要还没有任何输出就按 R-1 自动重跑；日志是一行 `bedrock_call_failed`（`error` 为 `ReadTimeoutError`，`status` 504）。不换用备选配置文件：停滞不是配置文件的拒绝，而且剩下的时间可能不够一次长调用，到时限的 `run_timeout` 反而不再重试。整个运行仍由 worker 自己的运行时限兜底（`asyncio.timeout`）。
- **为什么是 15 分钟**：Opus 5.5 先思考再写第一个字，思考完之前 Bedrock 什么都不发，正常的流也会安静几分钟。10-12 到 10-19 三个 worker 上完成的 3,384 次 Opus 5.5 调用里，等第一个 token 最长 436 s（第 99 百分位 230–296 s），没有一次超过 600 s；沙箱 worker 自 10-18 起首字节可以等 30 分钟，最长也只有 354 s。
- **计费**：停滞的调用照旧按估算计费（没有用量报告：输入字节加隐藏推理，上限 65,536 token，`plans.go` 的 `creditCharge`），与以前 25 分钟后以 `run_timeout` 结束时相同；R-1 重跑的每一次都单独计费，所以重跑若再次停滞会再计一次。10-25 起，没有任何返回就被截断的调用不再收费，见最后一节。
- **回滚**：回滚 Python worker 发布。

## 2026-10-21：Python worker 上不带工具的 Claude Opus 4.8 调用 3 分钟无字节即失败

- **起因**（运营方 10-21「按你的建议做第一个根因方案」：缩短首字节等待；其后选「按模型设限 + 试探」）：10-19 到 10-21 14:23Z，Python worker 上有 16 次画布节点调用整整 15 分钟没有任何返回，以 `provider_unavailable` 结束；12 次的节点在失败后 15 或 30 s（正是 R-1 的重试间隔）又运行，另 3 次稍后又运行，1 次没有再运行。16 次里 2 次是 Opus 4.8（10-20 04:54、06:10Z），节点重跑 34 s、32 s 就完成（首字 2.9 s、1.7 s）；14 次是 Opus 5.5，例如 10-21 09:00–10:29Z 同一个节点连续停滞 5 次（共 75 分钟），第 6 次运行 461 s 完成（首字 211.5 s），12:34Z 两个请求只有 11、14 个字的节点各停滞 900 s，重跑首字 26.5 s、39.7 s。
- **为什么只改 Opus 4.8**：Opus 4.8 不静默思考。10-12 到 10-21 Python 与沙箱 worker 上完成的 5,341 次 Opus 4.8 调用，整次调用最长 123.5 s，没有一次达到 3 分钟（等第一段文字最长 48.8 s）。读超时管的是任意两次读之间的空档，不只首字节；观测到的完成调用全程都不到 3 分钟，中途的空档就更短。3 分钟是按观测定的经验上限，不是保证：将来若有健康的调用安静这么久，也会被截断。Opus 5.5 不同：它总是先思考，思考完之前 Bedrock 什么都不发，可以把 64,000 token 的上限全部用于思考，要 11 分钟以上（commit 7b495004；这个 worker 上有 3 次不带工具的调用思考到当时的 32,000 token 上限，用了 354–390 s），所以静默的 Opus 5.5 调用可能仍在工作，仍等 15 分钟。上面的重跑数据说明 Opus 5.5 的长时间静默多半也是停滞，但要分清"还在思考"与"停滞"，得先看得到它的思考。其他模型没有测量，不在表里。
- **带工具的调用不论模型都不变**：Bedrock 要等工具调用的输入整段写完才发，一次工具调用写 32,000 token 的文件要 6–10 分钟（`apps/bedrock-bridge.ts` 的 `BEDROCK_STREAM_IDLE_MS`；10-18 PALLWARD 的构建调用因此在 300.7 s 被 AWS SDK 的 HTTP/2 空闲上限截断过）；调用账本（`model_invocations`）的 `provider_ttft_ms` 只在第一段输出是文字时才有值，带工具调用的首字节没有记录。画布节点的调用不给模型工具（只有节点团队的成员带工具，`teams.go`）。
- **改动**：`bedrock_bridge.py` 的 `QUICK_FIRST_BYTE_SECONDS`（按去掉推理配置文件前缀 `global.`、`us.` 等的 Converse 模型 ID 设限；现在只有 `anthropic.claude-opus-4-8`：3 分钟）与 `call_read_timeout`：这次调用的 ConverseStream 命令没有 `toolConfig`（没给工具，或 `tool_choice` 为 `none`）且模型在表里时，botocore 读超时取表中的值与原读超时中较短的；否则不变（流的空闲上限 15 分钟，运行时限更短时取运行时限）。主、备推理配置文件用同一个读超时。超时照旧报 504 `ReadTimeoutError`，worker 记为 `MODEL_UNAVAILABLE`（API 显示 `provider_unavailable`），日志一行 `bedrock_call_failed`。R-1 只在这次运行没有任何输出、画布运行仍在进行且还有重试次数时重跑该节点（`graphRunSilent`；默认最多 2 次，间隔 15 s、30 s）；先输出过文字再停 3 分钟的调用同样以 `provider_unavailable` 失败，但不重跑。按 10-20 的两次算，节点约 4 分钟就有结果（3 分钟截断、15 s 后重跑、约 33 s 完成），以前要约 16 分钟。代价：一个节点的三次尝试现在约 10 分钟内用完（3 × 3 分钟加 15 s、30 s 的间隔），以前约 46 分钟；Bedrock 若连续停滞超过约 7 分钟（其间发出的请求一直没有回答），节点可能失败、要用户再运行，以前后面的尝试可能等到它恢复。Python worker 上的 Bedrock 模型不接受 `reasoning_effort`（桥拒绝）。沙箱、Pi 与 JS worker 不变（沙箱的调用都带工具；Pi 另有自己的 300 s 首事件截断，见下）。
- **计费**：停滞的调用没有用量报告，按估算计费（`plans.go` 的 `creditCharge`：输入字节加隐藏推理，隐藏推理按首字前的时间每秒 120 token，上限 65,536 token）：首字前就安静了 3 分钟、被截断的调用估算约 21,600 隐藏 token（3 分钟 × 每秒 120），15 分钟时是上限 65,536；先出过字再停的调用按出字前的时间算。R-1 的每次重跑都是一次单独计费的运行。10-25 起，没有任何返回就被截断的调用不再收费，见最后一节。
- **另见**：同期 Pi worker 上有 3 次 Opus 5.5 节点在 302 s 以 `runtime_failed` 结束（10-21 05:21–05:32Z），是 pi-coding-agent 的 300 s HTTP 空闲默认值（10-14 已诊断，未修）。停滞本身没有查明：Opus 4.8 在这个 worker 上 16 次调用停滞 2 次，同一主机的沙箱 worker 5,333 次里一次也没有，可能与这个 worker 的调用方式（连接复用、认证）有关，这次只缩短了等待。
- **回滚**：回滚 Python worker 发布（换回上一个 release 目录的 drop-in 并重启）；或从 `QUICK_FIRST_BYTE_SECONDS` 删去该模型。

## 2026-10-21：Python worker 上 Opus 5.5 流式发回思考摘要，不带工具的调用也 3 分钟无字节即失败

- **起因**（运营方 10-21「确认」：Opus 5.5 请求带上思考摘要，并把它也纳入 3 分钟上限）：上一节说停滞本身没有查明；同日 opus55-stall 会话的只读调查（worktree jolly-margulis-5336cc 的 `.local/opus55-stall-20261021/REPORT.md`，以其修订版为准）查明：迁到 UCloud 后，这个 worker 的 183 次 Bedrock 调用里有 40 次静默失败（37 次 Opus 5.5、3 次 Opus 4.8；EC2 上 1,201 次为 0），没有一次是到截止时还在思考。CloudTrail 一一对上，分三类：
  - 17 次请求根本没到 Bedrock（没有响应头，也没有 CloudTrail 记录）。其中 8 次是空闲 1 小时以上后的第一次调用：从主机试，空闲 60 s 到 60 分钟的连接都还能用，空闲 90 分钟的一条已悄悄失效（请求没有确认，重传 6 次，也没有关闭）。但至少有一次（10-20 04:54Z）是在全新的连接上，另有原因，尚未查明。
  - 12 次 Bedrock 在 74–364 s 内已经答完（正常结束或到 32,000 token 上限），响应头也回来了，此后却一个字节都没收到。原因尚未查明。
  - 11 次 Bedrock 静默地跑了 559–647 s，到 64,000 token 上限，回答没有送回来。只有这一类符合"长时间静默就送不回来"：迁移后完全静默最长 360.6 s 的流都送达了，沙箱 worker 丢了 3 次 Bedrock 在 435–457 s 答完的调用。
- **为什么 Opus 5.5 会长时间没有字节**：Opus 5.5 总是先思考（自适应思考，不能关），桥原来不发 `thinking` 设置，Bedrock 用默认的 display "omitted"：思考结束前一个字节都不发，连 `messageStart` 都没有。10-21 14:38–17:21Z 在主机上用 worker 自己的凭证成功调了 19 次（另有 2 次因额度被拒，见下；5 次照现行请求，14 次加 `thinking: {type: adaptive, display: summarized}`，两个配置文件都每次接受）：现行请求下一次 26.9 s 的调用，响应头 2.3 s 后整整 24.4 s 没有任何字节；加摘要后，思考摘要在调用开始后 3.7–8.6 s 起持续发回（8.6 s 那次输入 110,668 token），任何一次调用里都没有超过 6.5 s 没有字节。思考最长的是同一道 250 步计算题：不加摘要时整整 192.5 s 一个字节都没有（195.2 s 答完，26,500 输出 token）；加摘要的两次分别思考 3.5 分钟和 3.2 分钟（212.7 s、197.9 s 答完），一路发回 1,953 段和 1,825 段摘要，最长间隔 6.5 s 和 4.9 s。同一问题加不加摘要耗时相近（26.9 s 对 26.8 s、28.5 s；195.2 s 对 212.7 s、197.9 s），输出 token 数相近（3,206 对 2,774、3,114；26,500 对 29,036、27,204）。3 分钟对健康调用仍是经验上限，不是保证：真有健康调用 3 分钟没有字节，也会被截断、由 R-1 重跑。另：这道题加摘要的第一次在 35 s 以 `content_filtered` 结束（没有正文，3,705 token），另两次和不加摘要的那次都正常答完。生产上 10-12 以来关联到运行的 2,906 条 Opus 5.5 调用记录（其中 Python worker 517 条，一次运行即一次调用）里，没有一条属于以 `model_refused` 结束的运行；这只说明没有运行因此结束，不说明 Bedrock 从未返回过 `content_filtered`。这种结束会以 `model_refused` 呈现（R-1 不重跑，提示用户修改任务），所以上线约一天后要读 Python worker 上 Opus 5.5 的 `model_refused`，逐个看；普通任务上再出现，就清空 `SUMMARIZED_THINKING_MODELS`（`THINKS_SILENTLY` 让上限随之回到 15 分钟）。脚本与输出：`E:/KiroCrew/run-timeout-20261021/first-event/probe-9.sh`…`probe-21-repeat.sh`（`probe-15-newbridge.sh` 是新桥在主机上经 worker 自己的 runner 跑通的一次：31.2 s，读超时 180 s，命令带着摘要设置）。备用配置文件 `us.` 也接受这个字段（16:57Z，`probe-19-us.sh`：不带时响应头 2.1 s 后 10.3 s 没有字节；带时 3.7 s 起发回思考摘要，95 段，最长间隔 3.2 s）；16:44Z 第一次试时两次调用（不带和带）都被 `ThrottlingException: Too many tokens per day` 立即拒绝，US 的额度当时用完了。
- **改动**：`bedrock_bridge.py` 的 `SUMMARIZED_THINKING_MODELS`（要求思考摘要的模型，现在只有 `anthropic.claude-opus-5-5`，按去掉推理配置文件前缀的 Converse 模型 ID）与 `with_summarized_thinking`：这类模型的每次调用都在 ConverseStream 命令里加上 `additionalModelRequestFields.thinking = {type: adaptive, display: summarized}`（带不带工具都加，主、备配置文件同一请求）。Opus 5.5 加入 `QUICK_FIRST_BYTE_SECONDS`（3 分钟），但它在 `THINKS_SILENTLY`（不要摘要就静默思考的模型）里，`call_read_timeout` 只在命令里确实带着这个摘要设置时才给它 3 分钟；带工具的调用仍是 15 分钟（Bedrock 要等工具调用的输入写完才发）。思考摘要在 worker 里只计字数（`ReasoningCounter`），不转发正文；画布节点的运行不要 reasoning 进度（`X-Awwo-Run-Activity` 只在规划时发送），`server.py` 照旧丢掉这些计数事件，所以节点运行发给 API 的事件流不变。
- **效果**：思考期间流不再长时间静默，第三类（长时间静默后丢失）应能送达；跑到 64,000 token 上限的会以 `output_limit` 结束（R-1 不重跑，提示拆分任务），不再每次重跑都再烧 64,000 token。代价：以前这类回答丢了，节点按 `provider_unavailable` 重跑，偶尔重跑能在上限内答完（节点 5a0b20 第 7 次用 51,949 token 完成），现在第一次就以 `output_limit` 结束，要用户拆分任务或自己再运行。前两类这次防不住，但不带工具的 Opus 5.5 调用有了思考摘要后正常时最多几秒就有字节，3 分钟收不到就以 `provider_unavailable` 失败、由 R-1 重跑，以前要 15 分钟（不带工具的 Opus 4.8 调用见上一节，也是 3 分钟）；带工具的调用和表外的模型仍等 15 分钟。连接方面的修复没有做，待运营方选择：每次调用等响应头单独设约 60 s 时限并重试一次（试探中响应头在 1.4–6.5 s 到，6.5 s 那次输入 110,668 token），以及处理连接池里久置的连接（keepalive，或关掉空闲 30 分钟以上的连接）。
- **计费**：思考 token 照旧计费，按 Anthropic 的说明显示方式只影响能否看到（试探中同一问题的 token 数相近）；没有用量报告的停滞调用按上一节的估算，3 分钟约 21,600 隐藏 token（10-25 起没有任何返回的不再收费，见下一节）。请求里多了 `thinking` 设置，提示缓存可能因此失效一次。
- **回滚**：回滚 Python worker 发布；或从 `SUMMARIZED_THINKING_MODELS` 删去该模型：请求恢复原样（没有 `thinking` 设置），它仍在 `THINKS_SILENTLY` 里，所以 3 分钟随之不再生效，退回 15 分钟（`test_a_model_no_longer_asked_for_the_summary_waits_the_idle_limit`）。

## 2026-10-25：被静默上限截断、没有任何返回的调用不收费

- **起因**（运营方 10-25「那就按照你的建议往下执行吧」，回应的建议是：这类被截断的调用不收费，与 10-18 定的"直接任务被时限切断只退那一次"同一个规则）：上面三节的静默上限（不带工具的 Opus 4.8、Opus 5.5 调用 3 分钟，其他 15 分钟）截断的调用一直照收：付费套餐按估算扣点数（3 分钟约 21,600 隐藏 token，15 分钟为上限 65,536），R-1 的每次重跑也单独扣；免费工作区每次都占一次每日调用。10-21 的调查查明这类静默多半是传输丢失（40 次里 17 次请求根本没到 Bedrock）。10-19 11:06Z 到 10-25，Python worker 上有 38 次这样的调用（截断在 3–14 分钟的 23 次，14 分钟以上的 15 次），Pi 上 6 次，都不是付费套餐的调用（`credit_reserve` 为空），没有扣过点数，但都占了每日调用。
- **改动**：
  - Python worker（`errors.py` 的 `stalled` 与 `classify_error`，`runner.py` 传入调用是否经桥）：桥的 504 `ReadTimeoutError` 记为新的 `MODEL_STALLED`，不再是 `MODEL_UNAVAILABLE`。只认 Bedrock 配置文件的调用（经桥发出的），且只认桥自己的失败，或 SDK 对桥的回答抛出的错误：流开始前的 HTTP 504，或流里的出错帧（SDK 抛出时不带自己的状态码），两种情况下错误体的类型与代码都是 `ReadTimeoutError`、状态为 504。别的提供方即使回了同样的错误体也不算，照旧是服务不可用；其他 504 与桥的其他失败不变。
  - API：`MODEL_STALLED` 仍显示为 `provider_unavailable`（`runs.go` 的 `runtimeFailureCode`），R-1 照旧重跑，提示文字不变。失败时没有输出过文字、也没有用量报告（部分报告也算报告）的这类调用（`plans.go` 的 `stalledBeforeOutput`；运行收到过"模型在思考"的信号也算，读者什么都没拿到），结算时（`invocation_ledger.go` 的 `settleInvocation`）记进 `refunded_calls`（原因 `stalled`；迁移 043 放宽原因检查。042 是 AwwO 本地版云端中转的 `042_relay_keys.sql`，10-25 04:58Z 随它上线）。之后付费套餐的点数记 0，每日调用退还：`direct_task_refund.go` 的 `refundedStalledCall`，与直接任务的退还合计每天最多退 32 次。单次运行与节点团队成员的调用都适用。
  - 每个工作区每天（UTC）最多这样退 32 次（`refundedCallsPerDay`，与直接任务的上限相同）。同一工作区的这类结算按工作区加锁、一次一个地数和记（`noteStalledCall`，锁到所在事务结束），同时结算也不会超出；先写退还记录，写进去了才把点数记 0，这次调用若已有别的退还记录就不再记、照常计费。超过上限的照旧计费，也不记录。这个上限防的是故意制造停滞：截断的调用对用户没有任何产出，运营方却可能已经为它付费。运营方付费的规划调用（规划模型上的调用，本来就不扣点数、不占每日调用）不占名额。上限按工作区计，与直接任务的退还相同；套餐按账号计费，一个账号有几个工作区就各有 32 次。
  - 锁与迁移：可能要记这条退还的结算（worker 报的是 `MODEL_STALLED`），在锁自己运行的那一行（或团队成员回合的那一行）之前，先对工作区那一行加 `FOR KEY SHARE`（退还记录的外键要用到它；`keyShareBeforeStalledNote`）。这与取消运行的加锁顺序相同（先工作区行 `FOR UPDATE`，再运行行），两者只会依次等待，不会死锁（Codex 第二轮：顺序相反时会死锁）；没有先这样加锁的结算路径一律不记退还、照常计费。它也可能要等同时进行的准入事务（它们对工作区行加 `FOR UPDATE`），通常只多几毫秒；每次结算尝试最多 2 s、共 5 次（`persistExecution`），只有持锁超过约 10 s 的事务才会让这次结算放弃、运行留到 API 重启时按预留计费，代码里没有这样的事务（安全审查第三轮）。迁移 043 删、加检查时对这张小表加排他锁，直到迁移提交（`lock_timeout` 10 s，与 039–041 相同）：等锁期间旧 API 读写这张表的查询（准入、直接任务的结算）会排在它后面，所以在没有运行时切换（换 API 的脚本本来就等到空闲）。
  - 照旧：路线额度（如 bedrock 每日次数）与全平台上限仍计这次调用，与 10-18 的直接任务规则相同，因为运营方可能已为它付费；先输出过文字再停的调用、有用量报告的调用、其他失败照旧计费。成本记录（`cost_status`、估算成本）不变，运营方的成本照实记。
- **不在范围内**：Pi 与沙箱这两个 JS worker 的静默截断仍报 `MODEL_UNAVAILABLE` / `MODEL_ERROR`，照旧计费（Pi 10-19 以来 6 次）。
- **发布顺序**：先发 API（迁移 043 在它启动时执行），再发 Python worker。反过来，旧 API 会把新 worker 的 `MODEL_STALLED` 读成 `runtime_failed`：R-1 不重跑，也照样收费。退还名额的计数靠结算事务在拿到锁之后才取快照，所以要求数据库默认的隔离级别是 READ COMMITTED（PostgreSQL 的默认值，准入逻辑本来就这样假定）。
- **回滚**：先回滚 Python worker，再回滚 API（反过来，旧 API 会把新 worker 的 `MODEL_STALLED` 读成 `runtime_failed`，R-1 不再重跑）。回滚 API 发布即停止退还：旧 API 不读原因为 `stalled` 的记录（它只把与直接任务退还记录对上的调用当作被切断，停滞的调用不属于直接任务），也不检查迁移 043，留下的这些记录无害，它自己写的 `timeout` 记录新检查照收（回滚演练 `rollback-proof-043.sh`）。可见的影响：当天已退还的停滞调用重新计入每日调用，免费工作区的当天用量最多会多出 32 次、可能因此到上限；已经记为 0 的点数不变。回滚 Python worker 后它重新报 `MODEL_UNAVAILABLE`，新 API 照旧计费。

## 2026-10-26：节点可以为 Claude Opus 5.5 选择思考强度

- **起因**（运营方 10-26 选定：让页面节点和规划器为 Bedrock 上的 Opus 5.5 选择思考强度，档位写在目录里，两个桥都发 `output_config.effort`）：当天 open-design 上线后的验证中，openai-agents 上两次 Opus 5.5 页面节点（群岛与单岛两种简报）都在 64,000 输出 token 上限处结束，没有交付页面，单岛那次约 58,000 token 是思考。Opus 5.5 不能关思考，强度默认 `medium`；而两个桥都拒绝请求里的 `reasoning_effort`，节点无法降低它。
- **实测**（2026-10-26，直接调用 ConverseStream，经本机代理）：
  - `low`、`medium`、`high` 在 `global.` 与 `us.` 两个配置文件上都被接受：与思考摘要（`thinking: {type: adaptive, display: summarized}`）并列、单独发送、提供工具、历史里有工具回合，四种都接受。
  - `xhigh`、`max` 也被接受。没有提供：它们在同一个上限内思考更多。
  - `minimal`、`none` 返回 400（`unknown variant`，列出它接受的五档）。
  - 同一个约 250 行的页面任务：`low` 3,473 个输出 token（页面 7,289 字符），`medium` 4,978，`high` 5,804。按 HTML 每 token 约 3.5 字节估，思考分别约 1,400、2,800、3,400 token。
  - 群岛节点的真实提示词在 `low`：12.8 s 起流式发回思考摘要，最长 12.7 s 没有字节，226 s 开始写页面。本机网络在 309 s 切断了连接，没能看到结尾。同一节点在默认 `medium` 下线上跑到了 64,000 上限。
- **改动**：
  - 目录：Opus 5.5 加 `reasoningEfforts: ["low", "medium", "high"]` 与 `defaultReasoningEffort: "medium"`。两个加载器（`bedrock-catalog.ts`、`bedrock_catalog.py`）都校验：只给 `vendor` 为 `anthropic` 的条目，至少一档，只能是桥发送的三档，每档一次，默认值必须在其中。
  - 桥（`bedrock-bridge.ts` 的 `toConverseInput`、`bedrock_bridge.py` 的 `to_converse_input`）：请求的 `reasoning_effort` 是档案提供的档位时，作为 `additionalModelRequestFields.output_config.effort` 发出。其他档位，或档案不提供强度时，照旧拒绝（400，请求不发出）。
  - 思考摘要与强度并列：`withSummarizedThinking` / `with_summarized_thinking` 合并字段，只在已经有 `thinking` 设置时让开。Python worker 的 3 分钟首字节上限照旧适用，`call_read_timeout` 只看 `thinking` 字段。
  - 桥在创建时校验档位（`createBedrockFetch` 的 `reasoningEfforts`、`BedrockConverseTransport` 的 `reasoning_efforts`，只能给 Claude 模型）。两个桥对共享向量 `bedrock-bridge-vectors.json`（新增 4 个）给出相同结果；TS 的测试现在也读这份向量。
  - Pi worker：health 列出每个模型的档位与默认值。
    - 运行请求可以带 `effort`。`config.mjs` 的 `validateRequest` 只收这三档；`server.mjs` 用 `effortAllowed` 按模型核对，只认 Bedrock 档案提供的档位，否则返回 400 `EFFORT_NOT_SUPPORTED`，运行不启动。
    - 子进程的 payload 钩子（`payload-hooks.mjs` 的 `withEffort`）把它作为 `reasoning_effort` 交给桥。
    - 直接任务（`computer-model.ts`）把调用自己点名的强度发给桥。档案的默认值从不发送，`none` 也不发。
    - 运营方的思考预算（`AWWO_PI_BEDROCK_THINKING_*`）不会给提供思考强度的模型；点名这样的模型时，worker 拒绝启动（生产只点名 `bedrock.claude-haiku-4-5`）。
  - Python worker：目录档案带上档位，health 照旧公布。运行的 `effort` 经 Agents SDK 作为 `reasoning_effort` 到达桥。
  - JS 与沙箱 worker 不变：它们的 Bedrock 档案仍不提供强度。
- **效果**：在 Opus 5.5 节点上选 `low` 时，思考约减半（上面的小页面 1,400 对 2,800 token），64,000 上限里留给页面的更多。网页的模型选择器在 Opus 5.5 下显示强度（`low` / `medium` / `high`，默认 `medium`）。不选强度时，请求与以前完全相同。
- **计费**：思考 token 照旧计费，强度越低思考越少，花费也越少。
- **回滚**：回滚 worker 发布即可。注意已经存了强度的节点：worker 不再公布档位后，API 会以 `effort_unsupported` 拒绝它们的运行；要在节点设置里把强度改回模型默认（网页把这样的已存强度显示为不可用）才能再运行。
