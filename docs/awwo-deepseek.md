# DeepSeek API：第三个运营方目标

DeepSeek API（`https://api.deepseek.com`，OpenAI 兼容）是 Gate-only 生产里除 LLM Gate、Bedrock 之外的第三个运营方目标。
只能以 `provider: "deepseek"` 的档案到达，且只能到达这一个地址；只用运营方凭证。2026-10-21 加入（业主：用 DeepSeek 降成本）。

## 为什么

- 价格（2026-10-21 官网，每百万 token，`deepseek-flash` = DeepSeek-V4.1-Flash-1017）：缓存未命中输入 $0.30 / 输出 $1.20（人民币账户 ¥2 / ¥8），
  缓存命中输入 $0.006；北京时间工作日 9–12 点、14–18 点为高峰，其余时段半价。Claude Haiku 4.5 是 $1 / $5，Opus 5.5 是 $4 / $20。
- DeepSeek 自动做前缀缓存，不用配置（规划器的固定指令在第二次调用起就按命中价计）。
- 支持工具调用、JSON 输出（`json_object`）、看图、1M 上下文、单次最多 384K 输出、并发 2500。**不支持** `json_schema` 结构化输出（400）。
- 数据在 DeepSeek（中国）处理。隐私条款没有列出 DeepSeek，开放给用户是业主待定事项，所以现在只有运营方自己的工作区能用（见「谁能用」）。

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

## 谁能用（API 的显式授权规则）

API 只把 DeepSeek 模型（worker 目录里 provider 为 `deepseek` 的模型）给两类工作区：模型白名单里写了它的，和没有白名单、由平台管理员拥有的
（运营方自己的，`operator_workspace.go`；有白名单的管理员工作区也要白名单写了它）。没有白名单的其他工作区本来能看到所有模型，但看不到 DeepSeek，
也运行不了（`tenant_models.go` `explicitOnlyProvider`，和即梦的显式授权同一个思路）。授权看工作区不看人：管理员拉进自己工作区的成员，
在那里也能用 DeepSeek。三处把关：

- 每次准入（运行、画布图的每个节点、节点设置、托管执行的模型列表、助手路由）读到的模型目录都先按这条规则过滤；
  过滤等于一份「除 DeepSeek 外全部模型」的白名单，worker 自己的默认模型在 DeepSeek 上时也一样被挡住。目录里没有 DeepSeek 模型时什么都不变。
- 规划器的目录是运营方自己的（不按工作区过滤），所以另外两处：`AWWO_PLANNER_MODEL` 是 DeepSeek 模型时，不能用它的工作区回到默认模型规划；
  附图时换成能看图的模型，也跳过它不能用的 DeepSeek 模型（`vision.go`）。
- 每次模型调用前的最后一道门（`teams.go` `reserveInvocation`）对 DeepSeek 调用再查一次实时的白名单和所有者，不管谁付费：
  运行途中撤销授权（白名单清成不限制），下一次 DeepSeek 调用就被拒（`model_not_allowed`）。

2026-10-21 生产：没有白名单的工作区 7 个，4 个是管理员的，3 个是 9 月的早期用户（9 月 30 日后没用过）；
其余 202 个的白名单都没写 DeepSeek。所以现在只有运营方自己的工作区能用。

业主更新隐私条款、决定开放后：把 `deepseek-flash` 加进 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 并补写现有白名单；要让没有白名单的工作区也看到、
或把规划器、默认模型换成 DeepSeek（它们处理的是用户的内容），再去掉这条规则。

用量计算：DeepSeek 模型不在 `AWWO_ROUTE_FREE_MODELS` 里时，按 `gate` 路线计（后台标签是「Claude / GPT」）；要按免费模型计就加进那个列表。
付费套餐要在 `AWWO_MODEL_PRICING_JSON` 里给每个运行时的 DeepSeek 模型定价（官方价 × 1.5），否则付费用户选它会被 `model_unpriced` 拒绝；
白名单里有它时（启用付费结账）启动检查也要求定价。

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
`reasoning_content`）。所以这两条路上 DeepSeek 的请求一律带 `thinking: {"type": "disabled"}`；调用方明确要求的思考强度（`none` 以外）
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

worker 声明 `deepseek` 后，健康信息的 `platformProviders` 变成 `["llmgate", …, "deepseek"]`；主机脚本（`host/switch-api.sh` 等）的 worker 检查
接受这几种列表，旧的发布工具若只认 `["llmgate", "bedrock"]` 要改那一行。

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
