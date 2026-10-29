# Agent 市场

> 状态：开发中（2026-10-29 起）。本文是这次改动的设计依据，API 小节是前后端共同遵守的契约。

## 目标

AwwO 里除了选模型，还能从市场里挑表现好、执行效果高的 Agent 来用；作者按调用拿收益，调用越多收益越多。

这次一起上线的范围：

1. **市场**：发布、平台审核、上架、按真实运行结果排行，在画布节点上选用并调用。
2. **按次收费**：作者给每次调用定价（点数，可以是 0），运行完成才扣；在 Agent 写出内容前就结束的、平台和服务商的故障都不扣。调用方拿到了 Agent 写的内容、运行却没算完成的情况照扣：Agent 已经写出内容后，调用方取消、节点自己的输出约定（调用方的配置）拒收、输出被截断、中途拒答或运行超时（业主 2026-10-29 选择照扣；这些结束不计入排行）。
3. **作者账本**：平台抽成（默认 25%），作者的份额只来自调用方买来的点数。
4. **转账（AwwO 一侧）**：收益过保留期后转进作者的 ClawHunt 钱包。这次上线时转账开关关闭，收益照常记账、显示为「待转入」：ClawHunt 现有的提现只能提解题收入（必须选具体的已验收问题），钱包入账与让 AwwO 收益可提现是 ClawHunt 的另一次发布（业主 2026-10-29 选择「先上市场，提现单独再上」）。

以后再做（不在这次范围）：画布助手与规划自动推荐、选用市场 Agent；直接执行（画布助手的任务）使用 Agent；本机版中转 API 按 Agent 调用；团队成员使用市场 Agent；外部托管的 Agent（A2A / ClawHunt 接单 Agent）。

## 名词

- **市场 Agent**（`market_agents`）：作者发布的一个 Agent，带多个版本。
- **版本**（`market_agent_versions`）：一份不可修改的定义：介绍、隐藏的指令、最多 4 个冻结的技能、推荐模型、价格、示例。价格属于版本，改价就是发新版本，要重新审核。
- **调用**（`market_agent_calls`）：一个节点用市场 Agent 跑的一次运行，一次运行一行。它既是计费记录，也是排行的数据来源。这张表不随工作区删除：作者的收益不能跟着调用方的工作区一起消失。
- **官方 Agent**：AwwO 自带的免费 Agent（作者为空，`official=true`），来自网页已经内置的 39 个 wshobson/agents 角色（MIT），指令公开；同一份内置里的 8 个公司角色不收，它们是写给彼此委派的 Agent 团队的，不适合单个画布节点。

## 数据（迁移 045）

| 表 | 用途 |
| --- | --- |
| `market_agents` | id、author_user_id（官方为空）、author_display（上架版本审核通过的署名）、official、status（draft / listed / unlisted / suspended）、suspended_from（停用前的状态，恢复时回到它）、listed_version、listed_at |
| `market_agent_versions` | (agent_id, version)、state（draft / pending / approved / rejected / superseded）、name、tagline、description、category、kind（目前只有 llm；列上保留 coding 留给以后）、instructions、instructions_public、skills（冻结的全文、hash、来源）、runtime / model / effort / model_locked、price_credits、examples、content_hash、author_display（这个版本的署名，随版本审核）、审核意见与时间 |
| `agents` 新增列 | market_agent_id、market_version：节点背后的工作区 Agent 指向哪个市场版本；它自己的 instructions 为空 |
| `market_agent_calls` | 一次调用：agent、version、作者、调用方工作区、run、发起人、计费账号与计费期（起止）、price_credits、fee_bps、insider、status（reserved / charged / released）、outcome、outcome_code、platform_fault、duration、model_credits、earned_microcredits、settlement（open / final / void / none）、payout_id |
| `market_agent_ratings` | 每次调用一个 👍/👎（call_id 唯一） |
| `market_payouts` | 一次转账：作者、ClawHunt subject、amount_cents、微点进位（carry_in / carry_out）、status（pending / sent / held / failed）、尝试次数 |

## 发布与审核

- 任何登录用户都能发布。可以从节点的配置面板「发布到 Agent 市场」（用节点的人设、技能、模型预填），也可以在「我的 Agent」里新建。
- 草稿保存时就冻结技能全文：内置技能、作者自己工作区的技能（作者至少是该工作区的成员）。从 skills.sh 导入的技能只有许可证明确宽松（open）时才能带进市场版本。
- 目前只收文字类 Agent（`kind` 为 llm）：第三方写的指令还不能带着沙箱电脑的文件、命令行和网络运行，推荐模型也不能是沙箱运行时。
- **署名**属于版本：草稿给的署名，或者不给时用账号名（同样要过检查，过不了就要求填一个）。它随版本一起审核，批准后才替换市场上显示的署名，改草稿不会立刻改掉已上架的署名。名称和署名都不能用 AwwO、ClawHunt、阿呜的名字，也不能自称官方（official、官方），否则 400 `market_name_reserved`。比较时按 NFKC 折叠、忽略大小写，把形似拉丁字母的西里尔与希腊字母、代替字母的数字和符号（0 读作 o，1 和 l 读作 i，3 读作 e，5 和 $ 读作 s，@ 读作 a）以及 vv、rn（读作 w、m）折叠，再去掉字母和数字以外的一切字符；网页在提交前按同样的规则先查一遍。
- 市场里的文字不能带任何看不见或会伪装的字符：控制字符（含 C1）、格式字符（软连字符、零宽、方向控制、标签字符等）、私用区字符、行与段落分隔符、非字符、显示为空白的谚文填充字符，以及变体选择符（只允许字符后面单独一个 U+FE0E 或 U+FE0F，即 emoji 的文字或彩色样式）。模型 id 只能是不含空格和逗号的可打印 ASCII。
- 提交审核后版本变成 pending。平台管理员在后台「市场审核」里看全部内容（含指令、技能全文和这个版本的署名），批准或驳回并写意见。检查提示词注入、冒名、违规内容。决定带上管理员读到的版本指纹（`reviewHash`，覆盖审核看到的每一项：介绍、指令、技能、模型、价格、示例、署名）：作者在管理员读过之后撤回、改动、再提交的版本，按旧读法做的决定被拒绝（409 `market_review_changed`），列表刷新后重新读。冻结进版本的技能文字也按市场文字的规则检查隐藏字符。
- 批准后该版本上架，旧的上架版本变成 superseded：已经锁定旧版本的节点继续用旧版本（价格也不变），新用户拿到新版本。作者已经下架的 Agent，新版本批准后仍保持下架。
- 作者可以撤回待审版本、下架（不再出现在市场，已在用的节点照常运行）、重新上架。管理员可以停用（所有使用立即停止：正在排队或运行的调用在停用的同一事务里取消，费用退回，`market_agent_suspended`；之后的运行一律拒绝）和恢复；恢复回到停用前的状态（作者下架的仍是下架）。

## 排行：怎么算“表现好”

只看真实运行，统计近 30 天，按 Agent 汇总所有版本：

- **不计入**：insider 的调用（作者本人发起的，或在作者自己是所有者的工作区里的，见计费）、取消、画布节点运行完成后没通过节点自己的交付检查（检查是调用方的配置）、完成了却没写出文字的运行，以及「失败」里没列的一切失败：平台、worker 或服务商的故障（限流、凭据、服务不可用、调用卡住、执行中断、worker 报不出原因的失败 `runtime_failed`、事件流断开等）、额度与套餐拒绝、交付文件存储失败、调用方节点的输出约定拒收（`output_contract_invalid`），也包括输出被截断、模型拒答、超时：这些既可能是 Agent 的问题，也可能是调用方的任务太大或服务商的问题，分不清的就不算 Agent 的（`marketAgentFaults` 是白名单，不是黑名单：新出现的失败码默认不计）。
- **成功**：运行完成并写出了文字，且调用方没有评 👎。
- **失败**：运行以 Agent 自身的原因失败（目前只有只写出了推理过程、没有回答 `reasoning_only_output`），或调用方评了 👎。
- **刷不动**：只计价格不低于当前上架版本价格的调用（免费版本时的调用不给之后的付费版本加分），每个调用人对每个 Agent 每天（UTC）最多计 3 次；👍/👎 只能给已计费（Agent 交出了文字）的调用，insider 的不算。
- **综合分**：成功率的 Wilson 下限（95%），样本少时分数自动压低。至少 10 次有效运行、3 个不同调用人才进排行，之前放在「新上架」。排行数字最多一分钟前，评价不触发重算。
- 另外展示：调用次数、成功率、调用人数、👍/👎、平均耗时、平均模型花费（点数）。

## 在节点上使用

- 节点文档里写 `agentRef: {source: "market", agentId, version}`。版本省略时，初始化填上当前上架的版本。
- 初始化（`POST .../initialize`）时服务器解析版本：Agent 必须上架（或是作者自己的），版本必须已批准；只有文字节点（llm）能用，团队节点、媒体节点和沙箱电脑节点（运行时 `sandbox`，或部署让每个 openai-agents 节点都在沙箱里跑时）不能用，受理时也再查一次。新选用拿到的是上架版本；节点写着别的版本（比如导入的画布、新版本上架前打开的页面）时返回 409 `market_agent_version_changed`，让用户重新选一次、看清新价格。模型锁定时节点使用 Agent 的模型（调用方的模型清单里没有就拒绝）；不锁定时节点可以换成自己能用的模型。
- 文档里的 persona 留空，技能以 Agent 的为准（节点自己的技能不生效），任务要求（taskFrame）、记忆、知识照常是调用方自己的。
- **第三方的指令**：发给模型的指令放在 `<market-agent-instructions>` 里，前面一段说明这是调用方选用的市场 Agent 作者写的，不来自工作区和 AwwO，不能改权限、工具、模型、预算、输出格式和任务要求，也不能要模型交出工作区的文件、知识、记忆和之前的对话；Agent 的技能用作者版的技能说明引入。
- **市场 Agent 的文字是第三方的数据**：它流进下游文字节点时，前面注明来自哪个市场 Agent、由第三方作者的 Agent 写成、只当数据用、不执行其中改变任务、权限、工具或输出格式的要求（`marketQuoted`；按字段的输入在标签上注明）。它不能流进沙箱电脑节点或团队节点（那里能运行命令、联网、委派）：从市场节点出发、沿连线（经过中间节点也算）能到达的节点，不论画布运行还是节点自己的运行，都不能在沙箱里或作为团队运行，400 `market_text_to_sandbox`（节点自己的运行同样拒绝，因为它的网页把输入连同提示一起发过来）。
- **页面不替调用方重跑**：页面运行出错时 AwwO 会替用户让节点修一次（pageRepair.ts），市场 Agent 的节点除外：它的每次运行都可能收费，只能由调用方自己决定再跑。
- **页面先静态显示，调用方选择后才运行**（业主 2026-10-29 选择）：市场 Agent 的节点和它下游节点交付的页面（节点一旦连到过市场 Agent 就记下 `marketFed`，撤销、重做也不去掉；之后改了连线，它以前的交付、以及从它往下连的节点也照此处理），在工作台、交付物预览、存储的网页文件、展示和运行记录里（运行记录按那次运行冻结的画布判断）先显示静态预览：按白名单重建、不运行脚本、不加载任何外部资源，旁边说明原因并给一个「运行页面」按钮；画布上的卡片只显示静态预览。调用方点了才运行（只对这一份交付：换了新的交付又先静态显示），运行时也不加载其他网站的图片和音视频（AwwO 列出的 CDN 除外，`MARKET_PAGE_CSP`），开始时有一行提示。运行起来的页面可能把它显示的内容发到其他网站，所以运行是调用方自己的选择；下载或发布后的页面同样由调用方决定。
- **提示词保护**：指令和技能全文不写进画布文档、工作区 Agent 行、setup_snapshot 和对话线程，只在运行受理时冻结进执行快照（服务器内部，不返回给浏览器）。市场接口只对作者、管理员或 `instructions_public` 的版本返回指令。模型被诱导时仍可能复述提示词，这一点无法完全防住，作者须知里写明。
- **旧网页保护**：发布后仍开着的旧标签页保存画布时，会把它不认识的市场节点整个删掉。新网页保存时带 `X-Awwo-Canvas-Features: market`；没带这个标记、又会删掉或改动已存市场节点的保存，返回 409 `canvas_reload_required`。

## 计费

- **扣谁**：和模型调用一样，扣工作区所有者的套餐点数（`billed_user_id` 与计费期）。
- **谁能用付费 Agent**：只有工作区的所有者和管理员（admin 以上）：Agent 费是从所有者的点数里付给第三方的，普通成员不能替所有者花这笔钱，否则 403 `market_agent_role_required`（节点自己的运行在受理时查发起人，画布运行在受理和每个节点受理时查画布运行的发起人）。免费 Agent 成员照常能用。
- **何时预扣**：节点运行被受理时（节点自己的运行在 `createRun`，画布运行的每个节点在 `admitGraphChild`），在套餐行锁之下检查点数够不够，插入一行 `reserved` 的调用。点数余额的计算（`creditsSpentSQL`）把 reserved 与 charged 的 Agent 费算进去，所以 Agent 费和模型费共用同一个余额，不会超支。
- **何时结算**（`marketChargedRun`，运行结束的同一事务里，后台任务补结算用同一条语句）：完成为 charged；Agent 已经写出文字后，调用方取消、节点自己的输出约定拒收（`output_contract_invalid`）、输出被截断（`output_limit`）、模型中途拒答（`model_refused`）、运行超时（`run_timeout`）也是 charged（`marketKeptTextEnds`），因为运行的文字调用方照样能看到，而且这些结束调用方都能在拿到文字后故意造成（业主 2026-10-29 选择「照扣」）；这些结束都不计入排行。其余结束（写出文字前就结束的、只写出推理过程的、中断、平台和服务商的故障）为 released。画布节点不会在这几种失败后自己重跑，所以不会在调用方不知道时扣两次。只有调用方自己的取消（运行的取消、画布运行的取消）才算：工作区被平台停用时取消的（`tenant_suspended`）、Agent 被停用时取消的（`market_agent_suspended`）、API 自己停下的（重启或失去数据库锁时运行自己的执行以取消结束，`execution_stopped`）都退回，并且不算 Agent 的失败。取消（调用方的、画布运行的、停用的）在取消的同一事务里结算费用：预扣的点数当场计入或放回，不会在运行真正停下之前被再花一次，画布在那之后被删也带不走这笔结算。画布节点运行完成后又没通过节点自己的交付检查时照扣（检查是调用方的配置，运行的文字已经在调用方手里），只有交付文件存不下（平台的故障）时退回。重试的每次尝试各自一行。
- **免费 Agent**（价格 0）不需要套餐。付费 Agent 要求工作区所有者有付费套餐，否则 402 `market_agent_plan_required`；点数不够 402 `credits_exhausted`。
- **自用**：作者本人发起的调用，以及在作者自己是所有者的工作区里的调用（模型费由作者自己的套餐付），不收 Agent 费、不产生收益、不进排行（insider）。作者只是成员的工作区照常付费：否则作者被加进别人的工作区，就能让那里免费用他的付费 Agent、绕开平台抽成。

## 作者收益与提现

- 每次 charged 调用的作者份额 = 价格 × (1 − 平台抽成)，平台抽成默认 2500 个基点（25%），在受理时冻结进调用行。
- **只算买来的点数**：一个计费期里买来的点数先花，赠送的后花。调用方的计费期结束、再过保留期（默认 14 天）后，按该期“买来的点数里能用于本期的部分（已付点数 − 上期结转）÷ 本期总花费”的比例（不超过 1）确定每次调用的最终收益。本期花费没超过已付点数时作者拿全额；有一部分花的是赠送点数时按比例减少；退款或拒付后已付点数为 0，收益为 0。
- **确定前再读一次套餐**：后台的套餐同步只读仍在生效的套餐，套餐取消后的退款和拒付它看不到。所以确定一个计费期的收益前，先按 ClawHunt subject 再向 ClawHunt 读一次调用方的套餐：ClawHunt 联系不上时这一期等下一轮；ClawHunt 拒绝或回答读不懂时也等，保留期过后再过 30 天仍读不到就按已有记录确定。仍然看不到的：调用方续费后对更早一期的退款（ClawHunt 只报当前期），以及确定之后的拒付，这部分要靠 ClawHunt 一侧（见下）。
- 计费期的数字（已付点数、上期结转）在 `user_plans` 还有这一期时由后台任务另存一份（`market_period_facts`），`user_plans` 只保留当前期和上一期。两处都没有的计费期一直不确定，记日志等运营处理，也不挡后面的计费期。
- **花费按见过的最多算**：工作区被删除时，它的模型调用和生成记录跟着删掉，这一期的总花费会变少，买来的点数「覆盖」的比例就会被抬高。所以后台任务每轮记下这一期**已结算**花费的最大值（`market_period_facts.spent`，不含运行中调用的预扣），确定收益时用「现在的花费」和「记下的最大值」里大的那个。两轮之间（10 分钟内）发生又被删掉的花费看不到。
- 付款人删除账号后，AwwO 不再有他的 ClawHunt 身份，确定前就无法再读他的套餐：之后的退款要靠 ClawHunt 一侧（见下）。
- 收益以微点（百万分之一点）记账，1 点 = 1 美分。转账按作者汇总后取整到分，不足一分的部分记在转账行上带到下一次。
- **转入 ClawHunt 钱包**：后台任务每 10 分钟一次，把已确定、未转出的收益按作者汇总，调用 ClawHunt 的 `POST /api/awwo/sso/earnings`（AwwO 自己的客户端凭证，转账行 id 作为幂等号），ClawHunt 给作者钱包记一笔 `awwo_agent_earnings` 交易，之后用 ClawHunt 已有的提现取出。没绑定 ClawHunt 的作者，收益一直累积，绑定后自动转入。ClawHunt 账号不可用（删除、封禁、撤销 AwwO 资格）时转账暂缓（held）。
- 转账开关 `AWWO_MARKET_PAYOUTS`，ClawHunt 一侧（入账接口与提现支持）上线并验证后再打开；之前收益照常记账，显示为「待转入」。第一笔收益最早在第一位付费调用方的计费期结束、再过保留期后才确定。

## 配置

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AWWO_MARKET` | off | 打开整个市场（关闭时市场接口 404，节点里的市场引用在受理时被拒绝）。关掉只停新的使用：已经发生的调用照常结算、确定和转账，作者的收益（`GET /market/earnings`）与管理员的转账记录（`GET /admin/market/payouts`）照常可读，网页的「我的 Agent」只在有收益时显示收益，平台管理显示「市场转账」 |
| `AWWO_MARKET_FEE_BPS` | 2500 | 平台抽成，基点 |
| `AWWO_MARKET_MAX_PRICE` | 500 | 单次调用的最高定价（点） |
| `AWWO_MARKET_HOLD_DAYS` | 14 | 计费期结束后的保留期 |
| `AWWO_MARKET_PAYOUTS` | off | 把确定的收益转入 ClawHunt 钱包（需要 ClawHunt 客户端配置，不需要市场开着） |

## API

以下路径省略 `/api/v1`。市场本身不属于某个工作区；用的时候按调用方的工作区判断。

### 浏览（需要登录）

| 方法与路径 | 说明 |
| --- | --- |
| GET /market/agents?q=&category=&sort=score\|calls\|new\|price&limit=&cursor= | `{items:[summary],nextCursor}`，只含上架的 Agent |
| GET /market/agents/{id}?version= | summary + `description, examples[{prompt,result}], skills[{name,title,attribution,license}], instructionsPublic, instructions?`（只对作者、管理员或公开指令的版本返回），作者另见 `status, latest`。带 `version` 时返回那个版本（节点锁定的旧版本显示它自己的价格），只要它是节点能运行的版本（已批准或已被替换）、Agent 上架或作者下架了 |

summary：`{id, name, tagline, category, kind, official, author:{name}|null, price, version, model:{runtime,id,effort,locked}, listedAt, stats:{calls, users, successRate|null, up, down, avgSeconds|null, avgModelCredits|null, score|null, ranked}}`。`author.name` 是上架版本审核通过的署名。

类别：`page` 网页与界面、`writing` 写作与文案、`research` 研究与分析、`code` 编程与工程、`design` 设计与创意、`media` 图像与视频提示、`business` 商业与营销、`education` 教育与学习、`other` 其他。

### 作者

| 方法与路径 | 说明 |
| --- | --- |
| GET /market/mine | 我的 Agent：summary + `status, listedVersion, latest:{version,state,reviewNote,submittedAt,price,authorName}` |
| POST /market/agents | 新建（版本 1 为草稿），请求见下，201 返回详情 |
| GET /market/agents/{id}/draft | `{id, status, listedVersion, authorName, listedAuthorName, draft}`：draft 是最新版本的全部字段（含指令和 `authorName`），只给作者；`authorName` 是最新版本的署名，`listedAuthorName` 是市场上现在显示的署名 |
| PUT /market/agents/{id}/draft | 改草稿；最新版本不是草稿时新建下一个版本的草稿 |
| POST /market/agents/{id}/submit | 草稿 → 待审 |
| POST /market/agents/{id}/withdraw | 待审 → 草稿 |
| POST /market/agents/{id}/unlist、/list | 下架、重新上架 |
| GET /market/earnings | `{feeBps, holdDays, payoutsEnabled, clawHuntLinked, pending, available, paid, payouts:[{id,amountCents,status,createdAt,sentAt}]}`，金额单位为点（= 美分） |

草稿请求：`{name, tagline, description, category, kind, instructions, instructionsPublic, skills:[{tenantId, ref}], model:{runtime,id,effort,locked}, price, examples:[{prompt,result}], authorName}`。限制：`kind` 只能是 llm（或省略），名称 ≤ 60 字符，简介 ≤ 120，介绍 ≤ 4000，指令 ≤ 32000 字节，技能 ≤ 4 个且合计 ≤ 20 KiB，示例 ≤ 3 个（prompt ≤ 2000，result ≤ 4000），价格 0 至 `AWWO_MARKET_MAX_PRICE`，署名 ≤ 40（省略时用账号名，账号名过不了检查时要求填写），推荐模型的运行时不能是 sandbox；隐藏字符与保留名称见上。

### 平台管理

| 方法与路径 | 说明 |
| --- | --- |
| GET /admin/market/reviews | 待审版本，全部字段与 `reviewHash`；`author:{id,email,name,display,listedDisplay}`，display 是这个版本的署名，listedDisplay 是现在显示的 |
| POST /admin/market/reviews/{agentId}/{version} | `{decision:"approve"\|"reject", note, reviewHash}`；reviewHash 必填，和版本现在的内容不符时 409 `market_review_changed`；批准时把版本的署名换上去，作者下架或已停用的保持原状态 |
| POST /admin/market/agents/{id}/status | `{status:"suspended"\|"listed"}` 停用与恢复，回答 `{agentId,status,runsStopped}`；停用时取消它正在进行的调用并退回费用；恢复回到停用前的状态（作者下架的仍下架，没有已批准版本的回到草稿），对没停用的 Agent 不改变状态 |
| GET /admin/market/payouts | 转账记录 |

### 工作区内

- `GET /tenants/{t}/capabilities` 增加 `market:{enabled, payouts, feeBps, maxPrice, holdDays}`。
- 运行（`GET /tenants/{t}/runs/{id}` 等）增加 `market:{agentId, version, price, status, insider, rating}`（只有用了市场 Agent 的运行才有）。`status` 是 reserved / charged / released：取消的运行也可能是 charged（见计费）。
- `PUT /tenants/{t}/runs/{id}/market-rating` `{score: 1 | -1 | 0}`，member 以上；只有已计费的调用（Agent 交出了文字，免费 Agent 也一样，`status` 为 charged）才能评，否则 409 `market_rating_unavailable`；0 撤销评价。
- 画布 `PUT` 请求头 `X-Awwo-Canvas-Features: market`（新网页总是带）。

错误码：`market_unavailable`（市场关闭）、`market_agent_not_found`、`market_agent_unavailable`（停用、下架后的新选用、版本不可用）、`market_agent_version_changed`（409，节点写的不是现在上架的版本，重新选用）、`market_agent_not_usable`（团队、媒体、沙箱节点，或 coding 节点）、`market_text_to_sandbox`（市场 Agent 的文字会流到沙箱或团队节点）、`market_rating_unavailable`（409，没计费的调用不能评）、`market_agent_model_unavailable`（锁定的模型调用方用不了）、`market_agent_role_required`（403，付费 Agent 只给所有者和管理员）、`market_agent_plan_required`（402）、`credits_exhausted`（402）、`canvas_reload_required`（409）、`market_review_changed`（409）、`market_draft_invalid`、`market_name_reserved`、`market_skill_unavailable`、`market_skill_license`、`market_hidden_text`、`market_price_invalid`。画布节点被拒时，节点的 detail 是同一个错误码。

## ClawHunt 一侧

`POST /api/awwo/sso/earnings`，AwwO 客户端凭证（与 `/plan` 相同），请求 `{subject, amount_cents, reference, note}`：

- 按 `reference` 幂等：同一个 reference 第二次请求返回第一次的结果（`duplicate: true`）。
- 账号已删除、封禁或撤销了 AwwO 资格：409 `payee_ineligible`，不记账。
- 成功：作者钱包加 `amount_cents`，写一笔 `awwo_agent_earnings` 交易，返回 `{credited:true, reference, transaction_id, duplicate}`。
- 这笔钱要能提现：ClawHunt 现在只允许提解题收入（`utils/withdrawals.py` 按 `source_problem_ids` 选），需要让提现流程与钱包页面也能选 AwwO 收益。这是 ClawHunt 的单独发布，走它的 staging 验证、评审与业主批准。
- 退款与拒付：`/plan` 要如实报出被退款或拒付的计费期（`paid` 归零），包括套餐已取消的；AwwO 在确定收益前会再读一次。确定之后才发生的拒付（以及调用方续费后对更早一期的退款）AwwO 看不到，ClawHunt 一侧要能暂扣或冲回已入账的 AwwO 收益（比如入账后一段时间内不可提现，或接受 AwwO 发起的冲回），在打开 `AWWO_MARKET_PAYOUTS` 之前定下来。

## 风险与已知限制

- 提示词可能被诱导说出（见上）。第三方指令的说明段只是一层提醒，不是边界：真正的边界是市场 Agent 只能作为文字 Agent 运行，没有沙箱、文件、命令行和网络。
- 确定之后的拒付、续费后对更早一期的退款，在 ClawHunt 一侧支持暂扣或冲回之前由平台承担（转账开关在这之前保持关闭）。
- 计费偏离了「成功才扣」的字面：Agent 写出文字后，调用方取消、节点自己的输出约定拒收、截断、中途拒答、超时都照扣，是为了堵住「拿到内容后让运行失败来免单」的漏洞。截断和超时也可能是 Agent 自己写得太长，这时调用方为一份不完整的回答付了费（文字归他）；业主 2026-10-29 选择照扣，这些结束不计入排行。
- 冷启动：早期付费用户少，作者收益会很小；官方免费 Agent 先把市场填起来。
- 排行可以被刷：付费 Agent 刷单要花自己买来的点数，平台抽成后必亏；排行只计不同调用人、每人每天每个 Agent 最多 3 次、价格不低于上架价格的调用，insider 的不计。免费 Agent 的调用不花 Agent 费（只花模型费），刷起来只受这几条限制，它的排行因此更容易被抬高。
- 页面一旦运行（调用方点了「运行页面」），或下载后用浏览器打开、发布出去，就照它自己写的运行，可能把它显示的内容发到其他网站：静态预览是默认，运行由调用方决定。
