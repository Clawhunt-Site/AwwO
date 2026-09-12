# AwwO 交付物预览与选区互审

日期：2026-09-12。本文记录本次实现的使用方式、已完成的本地验证及待验收项目。

发布状态更新：用户随后确认本次 0.5.0 的 Gemini 豁免并授权继续提交发布。应用提交 `edb7f3a26ecfaa08520a6f32fbb7b3c666de23c5` 已推送到 `main`／`online` 并部署到 AwwO 验收服务器，迁移 11 和独立运行读回通过。下文候选阶段的「尚未提交／部署」是当时记录；最终事实以 [0.5.0 发布验收](releases/0.5.0-verification.md) 为准。公网仍有 Cloudflare Access 门禁；本轮没有有效浏览器门禁会话，不声称已完成已认证公网画布验证。

## 查看交付物

打开组件的 Session，在右侧「交付物」中直接查看结果：

- **HTML** 默认显示页面，保留内联 CSS、页面样式与支持的 SVG 图形。
- **Markdown** 默认显示标题、列表、表格和强调等富文本。
- **源码** 展示原始内容；**下载** 保存对应 `.html`、`.md` 或服务器已有文件。
- **放大预览** 将内容放到独立于画布缩放的窗口，桌面使用大部分视口，手机使用全屏。可点击关闭或按 Escape 返回，焦点回到原按钮。

HTML 是静态预览：脚本、外部资源、页面导航和表单提交均被停用。预览使用独立的受限 iframe，不把生成的 HTML 插入应用页面；下载仍保留原始交付内容。依赖 JavaScript 或外部资源的页面，需要在合适的独立运行环境中验证其完整功能。

服务器文件按工作区权限读取实际保存的字节，只有 HTML 和 Markdown 文件提供预览。其他格式保留下载入口；本地路径只作为可复制的位置显示，不会被当成已经上传的文件。预览上限为 **2 MiB**，较大文件可下载查看。读取失败可重试，切换工作区或 Session 会丢弃旧请求的结果。

「历史交付」「部分结果」标签继续保留。看到可预览的候选内容，不代表它已经成为可传给下游的最终交付物。

## 框选组件，一键互审

此入口用于服务器工作区中的 **2–6 个独立 Session 节点**。

1. 点击画布工具栏的「框选组件」，从空白处拖动一个框包住参与组件；也可按住 Shift 拖动框选。Ctrl、Meta 或 Shift 点击卡片可调整多选。
2. 选区上方出现「互审优化」。直接点击可按组件任务开始，也可先打开「互审设置」。
3. 设置共同目标、互审轮数和负责汇总的节点。轮数可选 **1–3 轮**；汇总角色必须来自当前选区。
4. 执行按「各自提案 → 互相评议」推进，完成指定轮数后由汇总节点整理方案。每个组件沿用自己的 Session。
5. 查看当前阶段、参与节点、轮数和调用进度。成功完成后，汇总节点的交付物会展开。

若选中 `N` 个节点、设置 `R` 轮，模型调用上限为 **`2 × N × R + 1`**：每轮各节点提案一次、评议一次，最后汇总一次。例如，2 个节点 1 轮最多 5 次调用，3 个节点 2 轮最多 13 次调用。失败或停止可能使实际调用数少于上限。

节点已有数据输入连接时，本次互审读取其上游已完成且非 `partial` 的缓存产出；不会默认为缺失内容补值。更换配置后新开的 Session，或上游只有候选结果时，应先准备有效输入再开始互审。

## 流转和结果如何理解

临时连线依据服务端报告的执行阶段显示，表示已有提案或评议传向当前执行节点。它们不会修改已保存的连接结构，也不会在尚未发生传递时提前展示流动。缩放后的箭头保持可辨识，系统开启减少动态效果时停用线段动画。

提案以及未完成的汇总都是候选内容，保留 `partial` 边界；评议仅作为对话和回合证据，不作为节点交付物。只有整次互审成功完成、汇总节点产生有效最终输出后，该节点的结果才作为最终交付；其他节点的候选内容仍可查阅。互审不是严格共识协议，也不承诺数学意义上的「最佳方案」，应结合共同目标和验收要求检查最终结果。

Session 对话中的互审任务显示「轮次 · 提案／互审／汇总」和共同目标，完整契约、其他节点内容及原始提示词保留在折叠的执行详情中。这份摘要来自服务器实际回合的运行与 Session 身份，普通聊天中出现相同标记不会被认作内部任务。已完成的单 Agent 调用默认收起空成员记录，仍可手动查看运行状态；完整 HTML 在卡片中显示简短的预览提示。

失败、取消或中断不会把候选内容包装成成功结果。已经记录的回合和 Session 继续保留；刷新后按原运行身份读回状态，不因重新打开页面而自动重派发。点击停止后需等待服务器确认，不能把停止按钮本身当成任务已结算的证据。

## 与已有原生 Review Graph 的区别

| 项目 | 本次服务器选区互审 | 已有原生 Review Graph |
| --- | --- | --- |
| 入口 | 框选 2–6 个独立 Session 节点后互审 | 显式配置图策略、评审节点及反馈连接 |
| 过程 | 指定轮数内提案、评议，最后汇总 | 按图连接运行，以布尔评审结果决定通过或继续 |
| 连线 | 执行期间的临时流转提示 | 持久化的数据与反馈连接 |
| 最终产出 | 选定汇总节点的有效最终输出 | 原生图的契约与评审结果 |

已有原生评审配置不会被悄悄转换。本次新增的服务器入口也不代表旧式原生 Review Graph 已完整迁移到 SaaS。包含节点团队的选区暂不支持跨节点互审，需要选择独立 Session 节点。

## 验收记录

工作树：`E:\Bobo's Coding cache\bo-work\AwwO-worktrees\artifact-selection-review`。

开发基线：detached `cb96b76365444215da1e4ed4266c24b5f289ab08`。本记录形成时功能仍在该工作树中集成；基线 SHA 不是本次功能的提交或部署证明。

以下是已实际执行的本地检查。测试批次存在重叠，数量不能相加。

| 检查 | 已记录结果 | 覆盖范围 |
| --- | --- | --- |
| `canvas-artifact-preview.test.tsx`、`canvas-deliverables.test.tsx`、`canvas-stored-deliverable.test.ts` | 3 文件、56 项通过 | HTML 隔离、原始源码、Markdown、存储字节读取、取消与身份检查、大小限制、放大窗口及既有交付物行为 |
| `canvas-selection-gestures.test.tsx`、`canvas-group-move.test.tsx`、`canvas-node-disclosure.test.tsx` | 3 文件、15 项通过 | 卡片多选、组移动、展开收起、框选捕获及取消 |
| 后续 `canvas-artifact-preview.test.tsx`、`canvas-selection-gestures.test.tsx` | 2 文件、29 项通过 | 新增真实画布快捷键层与预览窗口的隔离回归，以及手势回归 |
| 最终手势检查 `canvas-selection-gestures.test.tsx` | 6 项通过 | pointer capture、失去捕获、卸载释放、修饰键点击不吞多选 |
| PostgreSQL 后端完整回归 | 通过，67.199 秒 | 专用本地 PostgreSQL 55497，独立测试 schema；日志 `.local/review-acceptance/backend-postgres-tests.txt` |
| 最后原子提交与相关后端回归 | 通过，13.624 秒 | 最终文件、回合、节点与整图终态在同一事务提交；停止与部分结果边界；日志 `backend-collaboration-atomic-tests.txt` |
| `TestPostgresCollaborationMessagePresentationUsesDurableTurnIdentity` | 通过 | 真实回合元数据、租户与 Session 匹配、原始消息不变、普通聊天标记不产生互审身份 |
| 最后已归档的前端定向回归 | 95 项通过 | `.local/review-acceptance/final-targeted-tests.json`；后续批次按最终验收继续补录 |
| `npm run test:saas` 最后完整 SaaS 批次 | 34 文件、342 项通过，18.11 秒 | 不含随后增加的助手 HTML 消息折叠摘要增量；该增量另行验证 |
| 最终相关前端回归 | 35 文件、358 项通过 | 已包含最后助手 HTML 消息折叠摘要增量，源码随后冻结；`final-saas-tests.json` |
| 前端广泛回归 | 1,149 项中 1,147 项通过，2 项失败 | 两项均在 `canvas-run-entry.test.tsx` 的原生运行入口；完整 HEAD 前端源码快照在相同依赖与测试配置下复现相同失败 |
| `tsc --noEmit -p tsconfig.saas.json` | 通过 | 最终 SaaS 前端类型检查，包含消息投影、HTML 摘要和空成员卡修复 |
| SaaS 构建 | 通过 | 已覆盖最后助手 HTML 消息折叠摘要增量；不代表部署 |

Vitest 在 `apps/web` 中通过 `npx.cmd vitest run --config vitest.saas.config.mjs <上述测试文件>` 执行。组件测试使用 jsdom，不能替代真实浏览器的渲染、网络策略或模型执行证明。

广泛前端测试没有全绿。两个失败用例分别为「runs a newly planned graph on the first click after binding and saving in the same page」和「clears only the accepted Session draft before dispatch and keeps it empty after reload recovery」。最初仅替换 HEAD 的 `CanvasSurface.tsx` 的检查不足以确认完整基线。随后用 `git archive HEAD apps/web` 导出 `cb96b76365444215da1e4ed4266c24b5f289ab08` 的完整前端源码、测试与配置到独立忽略目录，仅复用安装依赖，运行该文件的 6 个测试：4 个通过、2 个失败，名称与断言分别为调用次数 2/1、journal 非空，均与当前版本一致。两项为此测试环境下的基线失败，仍不计作通过。证据为 `.local/review-acceptance/frontend-tests.json`、`baseline-tests.json`、`full-head-baseline-tests.json` 与 `full-head-baseline-receipt.json`。

### 真实浏览器与真实模型

真实浏览器已验证：本地独立测试画布框选两个组件、HTML／Markdown 渲染、按提案 → 互审 → 汇总完成整轮执行，以及最终交付物展示。运行中刷新后，浏览器恢复同一运行的 `3/5` 进度，再观察到 `5/5` 并自动展开右侧交付物，没有重复派发。随后一次运行点击停止后显示取消，候选内容仍标明「部分结果 · 未完成」、可预览且没有下载动作。

独立只读 API 与 fixture 请求日志核验结果已保存到 `.local/review-acceptance/browser-final-receipt.json`：前三次已完成互审各恰好 5 次调用，第三次刷新恢复没有额外调用；第四次取消运行实际派发了 3 次调用（两次提案、一次互审），取消事件后没有后续派发。四次均保持原有两个已准备的 Session，取消后的节点保持 `partial` 并留存候选。核验时活跃整图、后端子运行和日志推导的活跃 fixture 调用均为 0。具体图 ID、回合 ID、Session 与输出摘要哈希见该回执。

浏览器运行使用明确标注的 Pi 协议 fixture，不能把其预设内容算成模型质量验证。最初 fixture 的 Agent 名称与节点标题不一致，首次初始化正确地新开了 Session 并清空缓存，互审在 0 次模型调用时被拒绝；已改为正式初始化后填写手动样例，再连续初始化两次验证 Session 与样例均稳定。

存储文件预览的真实浏览器验收也已通过：内联 CSS 和 SVG 正常渲染，桌面放大可用，`390 × 844` 手机视口全屏显示且无横向溢出。源码视图为 4,421 个 UTF-8 字节，SHA-256 `a1e5707ff2b76f1a6f74ce23db706d4f6098afb946857052ff4dd659219d60be`，与数据库／API 原文一致。预览 iframe 使用空 `sandbox` 且带 CSP，预览中移除了脚本、远程图片与导航链接，原始文件仍保留测试脚本、元数据和网络探针。点击表单探针没有导航或改变静态内容；受控探针日志只有 1 次明确的正向控制请求，目标产物标记请求数为 0。按 Escape 关闭放大窗口后，焦点回到「放大预览」按钮。

独立哈希／探针日志读回和浏览器观察分别记录在 `.local/review-acceptance/browser-storage-final-receipt.json`，并汇总到 `browser-final-receipt.json`；截图为 `stored-html-expanded.png`、`stored-html-mobile.png`。这项验收证明静态预览的隔离与原始字节保留，不表示脚本型应用已在预览中执行。

另以真实 `qwen3.8-27b` 模型，通过 Pi 执行层完成了一次独立本地验收：

- 图运行 `a3H1ErdcnDAhyegtPsgegd5h__0Us4uuk`，2 个既有节点、1 轮互审、1 次 HTML 汇总，**恰好 5 次模型调用且全部完成**。
- 每次互审的实际输入包含两份真实提案；汇总的实际输入包含两份提案和两份评议。五次调用的会话历史条数依次为 `0、0、2、2、4`，保持原有两个 Session 和节点指令／模型配置。
- 过程中候选结果带 `partial`；仅最终 HTML 汇总节点转为最终结果，Markdown 节点保留候选，评议没有覆盖节点交付物。原画布版本和未选中节点保持不变。
- 最终 HTML 从允许的字段 JSON 外层提取后通过完整文档与任务内容检查，共 662 个 UTF-8 字节，SHA-256 为 `57521023b67942ec7836360d123d5bf1e164afa88747b25711b68df111921412`。
- 结算后后端活跃运行／模型调用数和 Pi `activeRuns` 均为 0。首次验证脚本错误地把允许的字段 JSON 当作裸 HTML，修正检查后读回同一批五次运行，没有补发调用。

真实模型证据集中在 `.local/review-acceptance/REAL-ACCEPTANCE.md`、`real-receipt.json`、`real-terminal.json`、`real-settlement.json`、`real-source-manifest.json` 与 `real-final.html`。该测试使用本地专用 schema，不能作为 Codex 原生会话、服务器部署或真实模型浏览器交互的证明；后续消息读取投影／UI 变更不属于这次执行二进制的源码清单。

### 仍需补录与发布边界

- 最后助手 HTML 消息折叠摘要增量已纳入最终 358 项通过的回归，并完成类型检查和构建。真实浏览器已读回 7 条完整 HTML 回复的源码均默认折叠，历史轮次摘要正常。跨租户／Session 切换的取消与旧响应隔离已有组件／API 回归，其结果不扩写为所有浏览器交互组合都已实测；两项原生入口失败已完成完整 HEAD 对照。
- Codex GPT-5.5 对最终冻结源码的只读审查结果为 **PASS，无阻断项**；这是代码检查，未代跑浏览器或模型验收。留有一项 P3：前端互审摘要对共同目标限长 4,000 字符，后端可接受更长的目标，直接 API 传入超长目标时会回退显示原文而非摘要，内容不会丢失。
- Gemini 的原 OAuth 路径因 `UNSUPPORTED_CLIENT` 未能执行成功。本轮检查用户、工作区、系统及 system defaults 配置，未发现强制认证类型；保持全部策略和原配置不变，仅用官方临时 system settings 选择已有环境 API key。最小验证在 2026-09-12 返回 **403 `PERMISSION_DENIED` / `CONSUMER_SUSPENDED`**，已停止该路径，没有换账号、provider 或重试权限拒绝，也没有发送本次源码进行 Gemini 审查。原配置前后 SHA 一致；脱敏证据为 `.local/review-acceptance/gemini-api-review.auth-audit.json`、`gemini-api-review.smoke-receipt.json` 和 `gemini-api-review.smoke-1.stderr.log`。**Gemini 审查未通过**，此前版本的豁免不能自动覆盖本轮。
- **尚未提交、推送或部署本次版本。** 后续应补录最终提交／源码树、目标环境、运行目录及部署后读回。本地通过、既有版本运行和审查通过均不能代替本次上线证明。

最终 Codex 审查对应 381 个源文件，行为清单 SHA-256 为 `4322332eee1b9479819e71720357339b26aa0ea2bdf278282f972b8c379d0ee7`。唯一已核验的审查期间差异是将新增 HTML 对话回归纳入 `test:saas`；详见 `codex-final-freeze-receipt.json`。真实模型验收服务在确认活动任务为零后停止，仅保留结果与隔离数据；浏览器验收环境仍可本机访问 `http://127.0.0.1:15190/`，其中运行结果明确标为协议 fixture。

服务器只读预检确认 AwwO 验收实例 `i-0eda5599cbd603c8b` 上当前仍是既有 `saas-f3be5f7` API／网页，以及 `saas-48b96d7` Pi 执行层；SaaS 数据库为回环端口 `55483`，迁移为 1–10，检查时所有运行计数为零。新版本需要迁移 11；尚未执行备份、切换或新迁移。预检细节及发布／回滚步骤保存在 `.local/review-acceptance/release-preflight.md`。公开入口 `https://awwo.clawhunt.store/` 有外层访问控制，不能将未认证访问结果当成本版本部署证明。

残余限制：当前预览不执行脚本、不加载外部资源；其他文件格式只提供下载；含节点团队的选区不参与此模式；互审过程提供多个视角及综合方案，不提供严格共识或最佳性保证。


## 本次提交发布授权 — 2026-09-12

在明确告知 Gemini 两种既有认证通道均不可用，并询问「是否允许本次 0.5.0 豁免 Gemini 审查，继续推送并部署」后，用户回复「继续提交发布」。本次确认授权当前 0.5.0 候选版使用 Codex GPT-5.5 最终审查及已记录的本地、浏览器、真实模型证据完成提交、推送和 AwwO 验收服务器部署。Gemini 没有通过审查；豁免仅用于本次候选，不改变今后的双审要求。

提交前已重新确认 381 个被审查源码文件未变、精确暂存范围仅为本任务的 57 个源代码／测试／说明／版本文件。完整前端 HEAD 对照验证了 317 个 Git blob 一致。部署状态与最终提交、运行版本将在执行后另行追加；本授权不表示部署已经完成。
