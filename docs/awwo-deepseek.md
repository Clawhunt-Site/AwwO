# DeepSeek API：第三个运营方目标

DeepSeek API（`https://api.deepseek.com`，OpenAI 兼容）是 Gate-only 生产里除 LLM Gate、Bedrock 之外的第三个运营方目标。
只能以 `provider: "deepseek"` 的档案到达，且只能到达这一个地址；只用运营方凭证。2026-10-21 加入（业主：用 DeepSeek 降成本）。

## 为什么

- 价格（2026-10-21 官网，每百万 token，`deepseek-flash` = DeepSeek-V4.1-Flash-1017）：缓存未命中输入 $0.30 / 输出 $1.20（人民币账户 ¥2 / ¥8），
  缓存命中输入 $0.006；北京时间工作日 9–12 点、14–18 点为高峰，其余时段半价。Claude Haiku 4.5 是 $1 / $5，Opus 5.5 是 $4 / $20。
- DeepSeek 自动做前缀缓存，不用配置（规划器的固定指令在第二次调用起就按命中价计）。
- 支持工具调用、JSON 输出（`json_object`）、看图、1M 上下文、单次最多 384K 输出、并发 2500。**不支持** `json_schema` 结构化输出（400）。
- 数据在 DeepSeek（中国）处理。ClawHunt 隐私政策第 08 条（2026-10-21 更新）写明了这一点，并承诺只有选了 DeepSeek 模型的请求才发给它，
  AwwO 自己从不选它（见「谁能用」）。

## 配置

API 与每个提供 DeepSeek 模型的 worker 都要把 `deepseek` 写进 `AWWO_PLATFORM_PROVIDERS`（规范顺序 `llmgate,bedrock,deepseek`）。

密钥只放在一个变量里：`AWWO_DEEPSEEK_API_KEY`，只在 worker 的环境里（root 专用的 0600 环境文件），不进 API 或网页进程。
DeepSeek 档案的 `apiKeyEnv` 必须是它；默认模型在 DeepSeek 上时，默认档案读它而不读 worker 自己的 `AWWO_PI_API_KEY` /
`AWWO_OPENAI_AGENTS_API_KEY`；别的档案（Gate、Bedrock）都不能引用它。这样 DeepSeek 的密钥只会发到 DeepSeek，别的密钥也不会发到那里。

Pi（`AWWO_PI_MODELS_JSON`）：

```json
[{"id":"deepseek-flash","provider":"deepseek","model":"deepseek-flash","apiKeyEnv":"AWWO_DEEPSEEK_API_KEY","contextWindow":1000000,"maxTokens":32768,"input":["text","image"]}]
```

Python worker（`AWWO_OPENAI_AGENTS_MODELS_JSON`，Agents 节点每次只调用一次模型；它的思考强度只有 `low`、`medium`、`high`，写 `none` 会拒绝启动）：

```json
[{"id":"deepseek-flash","name":"DeepSeek V4.1 Flash","provider":"deepseek","model":"deepseek-flash","apiKeyEnv":"AWWO_DEEPSEEK_API_KEY","contextWindow":1000000,"maxTokens":32768,"reasoningEfforts":["low","medium","high"]}]
```

JS worker（`AWWO_OPENAI_AGENTS_MODELS_JSON`，生产的 sandbox worker 跑这份代码做项目执行，与 JS worker 共用一个目录文件）：不写
`reasoningEfforts`（最多只能写 `["none"]`）。这个 worker 的两条多次调用路径都不让 DeepSeek 思考（见下），列出的思考强度只会被选了再拒绝：

```json
[{"id":"deepseek-flash","name":"DeepSeek V4.1 Flash","provider":"deepseek","model":"deepseek-flash","apiKeyEnv":"AWWO_DEEPSEEK_API_KEY","contextWindow":1000000,"maxTokens":32768}]
```

规则（三个 worker 一致，违反即拒绝启动，配置错误绝不退回到别的目标）：

- `provider: "deepseek"` 的档案必须是 `https://api.deepseek.com` + Chat Completions；写了别的 `baseURL`（含结尾斜杠、大写）或协议都拒绝，Gate-only 与否都一样。
  默认档案也一样：`AWWO_PI_BASE_URL` / `AWWO_OPENAI_AGENTS_BASE_URL` 指到别处就拒绝。
- 反过来，Gate-only 时别的 provider（`openai`、`llmgate` 等）指向 DeepSeek 的地址也拒绝：只有 `deepseek` 这个名字能到 DeepSeek。
- `AWWO_LLMGATE_ONLY=true` 时，策略里没有 `deepseek` 就拒绝 DeepSeek 档案。
- `AWWO_CREDENTIAL_MODE=user` 的 worker 拒绝 DeepSeek 档案（个人连接仍只走 LLM Gate）。
- 密钥规则见上；`AWWO_DEEPSEEK_API_KEY` 的值和别的档案的密钥相同（贴错了变量）也拒绝，没有 DeepSeek 档案时也一样
  （否则那把密钥会发到别的服务）。
- `structuredOutput: true` 拒绝（DeepSeek 没有 `json_schema`；Python worker 本来没有结构化输出，也照样拒绝）。
- 关了思考（`disableThinking: true`）的档案不能再列思考强度（`none` 除外）。JS worker 上的 DeepSeek 档案只能列 `none`。
- 健康信息只声明实际到达的目标：有 DeepSeek 档案时 `platformOnly: true, platformProviders: ["llmgate", …, "deepseek"]`；策略里写了 `deepseek`
  但没有档案时，仍逐字节是原来的 `llmgateOnly: true`。API 拒绝列表外的 DeepSeek 模型，也拒绝藏在 Gate-only 声明后面的 DeepSeek 模型。
- 重定向即失败，不会把请求发到别处：Python worker 对 DeepSeek 的请求不跟随重定向；JS 与 Pi 的运行和托管执行的请求本来就是 `redirect: 'error'`。

## 谁能用（2026-10-21 起所有用户；只在有人选了它时运行）

业主 2026-10-21：「先改隐私条款，然后对所有用户开放 DeepSeek」。ClawHunt 隐私政策第 08 条写明 DeepSeek（杭州深度求索，在中国境内处理）
之后，DeepSeek 模型（worker 目录里 provider 为 `deepseek` 的模型）和其他模型一样按工作区的模型白名单提供：没有白名单的工作区都能用，
有白名单的要白名单写了它。生产上新工作区的列表（`AWWO_NEW_WORKSPACE_ALLOWED_MODELS`）和现有的白名单都加了 `deepseek-flash`。
（之前只给运营方自己的工作区，见 `5acdbe38`。）

条款承诺：只有选了 DeepSeek 模型的请求才发给它，由用户自己选，或用户让画布助手改模型时由助手选；AwwO 的规划、助手消息路由和它自己的
默认模型从不用它，也从不自己把请求换到它上面。所以 AwwO 自己从不选它（`tenant_models.go` `userChosenProvider`）：

- 空选择（节点、成员、托管执行没选模型）解析默认模型时跳过它：worker 自己的默认模型在 DeepSeek 上时不用，替补也跳过它；
  没有别的模型可用就是没有默认（`model_unavailable`），不会退到 DeepSeek。
- 附图时换成能看图的模型，从不换到 DeepSeek（`vision.go` `seeingModels`）。
- `AWWO_PLANNER_MODEL` 是 DeepSeek 模型时，规划一律回到默认模型（`planner_model.go` `plannerModelSnapshot`）；每次模型调用前的最后一道门
  （`teams.go` `reserveInvocation`）也拒绝记成运营方自付的 DeepSeek 调用（`model_not_allowed`）。
- 空模型只在 worker 的默认模型不在 DeepSeek 上时才原样发给 worker（让它用自己的默认模型）；在 DeepSeek 上时，有白名单的工作区
  按白名单换成别的模型（同上），没有白名单或白名单里没有别的模型就拒绝（`model_unavailable`；`teams.go` `modelLimits`）。
- 网页自己做的选择也一样（`apps/web/src/canvas/userChosenModels.ts`；API 在运行时目录和托管执行目录里把这种模型标成 `userChosen`，
  worker 没列出的、只能由用户选的默认模型也列出来并标上）：直接执行在读者没选模型时用的第一个模型、任务因额度被拒后建议的默认模型都
  跳过它（没有别的模型就不选，等读者自己选，`useManagedExecution.ts`、`AssistantExecution.tsx`）；Jev 给新角色分配的候选模型里没有它
  （`jevPlanning.ts`）；画布规划能用的模型列表里没有它，`set_model` 也只能在这个列表里找（`CanvasSurface.tsx`）；节点改进沙盒时换的
  模型也跳过它（`InspectorPanel.tsx` `withSandbox`）。不管请求里写了什么都这样：只有读者自己在模型选择器里选，才会用到它。
- 只有认得这个标记的页面才看得到这种模型：网页经 `api()` 发的请求都带 `X-Awwo-Model-Marks: userChosen`（`apps/web/src/saas/api.ts`；
  两个模型目录都经它读），运行时目录和托管执行目录对没带它的客户端不列这种模型（`tenant_models.go` `listedFor`）。发布前打开、还没刷新的旧页面会自己挑模型
  （第一个模型、Jev、规划器的列表），这样它根本看不到 DeepSeek。
- 用户自己选的（节点、Agent、团队成员、托管执行、账户默认模型）照常运行；白名单照常每次调用都查，运行途中从白名单拿掉，下一次调用就被拒。
  条款也允许用户让画布助手把模型改成它，但网页分不清一条请求是不是真在要 DeepSeek（「别用 DeepSeek」也写了它的名字），所以画布助手
  目前不会选它：让它改用 DeepSeek 时，节点保持原样，回复说明这个模型只能由用户自己在节点设置里选（`canvasPlan.ts`，模型列表来自
  `userChosenModels.ts` `planModelsOf`）；Jev 遇到要求它的目标、而工作区还有别的可用模型时也这样说（`jevPlanning.ts`；只剩这种模型时
  Jev 只说工作区没有可用于执行节点的模型）。

要让规划器或默认模型用 DeepSeek，先改条款，再改这几处。撤回：从 worker 的模型目录拿掉 `deepseek-flash`（每个 worker 空闲时重启一次）
对所有工作区同时生效，前提是 worker 自己的默认模型不在 DeepSeek 上（worker 会把自己的默认模型补回目录；生产的默认模型都不是）；
只撤某些工作区就改它们的白名单。

用量计算：DeepSeek 模型不在 `AWWO_ROUTE_FREE_MODELS` 里，按 `gate` 路线计（后台标签是「Claude / GPT」，与 Gate 上的模型共用每日上限）；
要按免费模型计就加进那个列表。付费套餐按 `AWWO_MODEL_PRICING_JSON` 扣积分（官方价 × 1.5）；新工作区列表（`AWWO_NEW_WORKSPACE_ALLOWED_MODELS`）里有它、启用付费结账时，启动检查要求
两个运行时都有定价。生产定价（2026-10-21）：`pi:deepseek-flash` 与 `openai-agents:deepseek-flash` 都是官方高峰价，输入 `300000`、输出
`1200000` 微美元 / 百万 token，缓存命中按输入价计（`included_in_input_rate`），思考按输出计，逐项向上取整；版本
`awwo-list-2026-10-06+haiku-4-5+deepseek-flash`。

## 思考

DeepSeek 默认先思考再回答，思考 token 计入 `max_tokens` 和输出价。关思考有三种方式：

- 档案的 `disableThinking: true`：发 DeepSeek 自己的 `thinking: {"type": "disabled"}`，不发 Qwen 式的 `chat_template_kwargs`
  （DeepSeek 忽略它）。Pi 只允许 DeepSeek 档案带这个开关；`AWWO_PI_DISABLE_THINKING` 现在也接受默认模型在 DeepSeek 上。
- 请求的思考强度 `none`（JS worker；DeepSeek 把它当作不思考）。
- 托管执行（`/internal/computer-model`）的 `thinking: false`，以及档案列出了 `none` 时的思考强度 `none`，都发 DeepSeek 的写法。

托管执行对 DeepSeek 一律流式发送再收拢（同 LLM Gate），避免先思考期间什么都不返回。

**工具循环里不思考。** DeepSeek 要求：带 `tools` 的请求，之前每一轮的 `reasoning_content` 都要原样回传，否则返回 400
（官方 thinking_mode 文档；2026-10-21 实测暂时放行，但不能依赖）。AwwO 有两条多次调用的工具循环保存不了它：
托管执行（线程里不保留推理，`gatherChatStream` 跳过它）和 sandbox 的项目执行（固定版本的 Agents SDK 不收也不回传
`reasoning_content`）。所以这两条路上带工具的 DeepSeek 请求一律带 `thinking: {"type": "disabled"}`（托管执行不带工具的那次调用照常
可以思考，`apps/computer-model.ts`）；调用方明确要求的思考强度（`none` 以外）
直接拒绝（托管执行 `EFFORT_NOT_SUPPORTED`，项目执行 `MODEL_REQUEST_REJECTED`），不会悄悄丢掉；档案自己的默认强度没人要求，随思考一起不发。
只调用一次模型的路径（Pi 的运行不带工具，Agents 节点 `max_turns=1`）照常思考；它们的对话历史里没有 `reasoning_content`，
DeepSeek 接受（2026-10-21 实测 7 种组合全部 200，见验收记录）。

## 压缩

客户端声明接受压缩时，DeepSeek 会把流式回答压缩（gzip、br、zstd）。Python worker 的用量观察器读的是压缩前的原始字节，
所以 Python worker 的请求一律声明 `Accept-Encoding: identity`；没有这条时每次 DeepSeek 调用都会失败成 `MODEL_PROTOCOL_ERROR`
（2026-10-21 实测）。这一条部署后对所有 provider 生效（LLM Gate、个人连接、Bedrock 桥接都照常工作）。JS 与 Pi worker 的观察器读的是
fetch 解压后的正文，不受影响。

## 部署顺序与回滚

1. 先部署认识 `deepseek` 的 API（只换二进制，不改环境时行为不变）。
2. 再部署新 worker 代码（没有 DeepSeek 档案时健康信息不变，旧 API 也能用）。
3. 设置，先 API 后 worker：先在 API 的 `AWWO_PLATFORM_PROVIDERS` 加 `deepseek` 并重启 API；再给 worker 加密钥环境文件、策略和档案并重启。
   顺序反了，声明 `deepseek` 的 worker 会被还不认识它的 API 整个拒绝（Pi 上包括规划器和助手）。

回滚倒过来：先去掉 worker 的档案和策略，再去掉 API 环境里的 `deepseek`，最后才能换回旧二进制。环境里有 `deepseek` 时，旧版 API 和旧版 worker
都会拒绝启动。

对所有用户开放的那一版（2026-10-21）先上 API、再上网页，最后才改设置和白名单。网页切换（`host/switch-web.sh`）的 `EXPECT_API`
要填这一版自己的 SHA，这样新 API 不在服务时它不切换。
新 API 配旧页面没问题：旧页面不带 `X-Awwo-Model-Marks`，新 API 不给它列 DeepSeek。反过来不行：旧 API 不标 `userChosen`，照旧把 DeepSeek
列给运营方自己的工作区和白名单写了它的工作区，新页面就会把它当成可以自己选的模型。回滚倒过来：先回滚网页，再从现有白名单和
`AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 拿掉 `deepseek-flash`，最后才回滚 API（旧版 API 附图时也可能把运行换到白名单写了的 DeepSeek 模型上）。
这样回到这一版之前的状态：旧版 API 仍把 DeepSeek 列给平台管理员自己的、没有白名单的工作区，旧页面在那里会自己选它。要连这也避免，
回滚 API 之前先从 worker 的模型目录拿掉 `deepseek-flash`（每个 worker 空闲时重启一次；worker 的默认模型不能在 DeepSeek 上）。

worker 声明 `deepseek` 后，健康信息的 `platformProviders` 变成 `["llmgate", …, "deepseek"]`；发布工具包自带的受控 API 切换脚本的
worker 检查接受这几种列表，旧的发布工具若只认 `["llmgate", "bedrock"]` 要改那一行。

生产的 sandbox worker 读的是 JS worker（:8098，不在 API 的路径上）的模型目录文件。只要 :8098 还跑不认识 `deepseek` 的旧代码，就不能把 DeepSeek
档案放进那个文件：它下次重启会拒绝启动，而 API 的切换脚本要求 :8098 健康。先升级或下线 :8098，再给 sandbox 加 DeepSeek。

## 验收记录（2026-10-21）

本机 WSL（Node 22.22）与 Windows Python 3.12 venv，真实 DeepSeek API，按生产方式配置（Gate-only、策略 `llmgate,deepseek`）：

| 路径 | 结果 |
| --- | --- |
| Pi 运行（规划器、助手、Pi 节点） | 开思考完成（推理 18 token）；`disableThinking` 完成（无推理）；用量 reported |
| JS worker（sandbox 的代码） | 默认、思考强度 `none`、`disableThinking` 都完成；后两者无推理 |
| Python worker | 修复压缩问题前三次都 `MODEL_PROTOCOL_ERROR`；修复后默认、`low`、`disableThinking` 都完成 |
| 托管执行 | 流式；默认与 `thinking: false` 都完成（0.8 s） |
| 看图（API 层） | 与 worker 相同的 base64 data URL `image_url` 片段：读对图片颜色 |
| 对话历史（API 层） | 之前的助手回复不带 `reasoning_content`：默认思考、思考强度 high、关思考、列出工具，7 种组合全部 200 |

规划器对比：同一份托管规划提示（当前代码生成的 5 个场景：改验收标准与模型、修复超限的 92 KB 画布、贪吃蛇、
三图一视频一网页的宣传片、带数量约束的报告），用当前代码的 `applyCanvasPlan(…, hosted)` 应用答案：

| 模型 | 应用成功 | 5 次总耗时 | 5 次总价 |
| --- | --- | --- | --- |
| Claude Haiku 4.5（生产规划器，思考预算 2048，生产主机同一座桥） | 5/5 | 80 s | $0.103 |
| DeepSeek V4.1 Flash，思考 | 5/5 | 111 s | $0.035 |
| DeepSeek V4.1 Flash，不思考 | 5/5 | 35 s | $0.016 |
