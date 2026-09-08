# AwwO 本地全框架验收报告

日期：2026-09-08（Asia/Shanghai）

**当前本地文本协作核心可用；“全部功能可用 / 可直接作为公网 SaaS 发布”验收不通过。**

本轮实际启动 Go、PostgreSQL、Pi 0.85.1 与现有前端，通过真实浏览器操作、外部 GPT-5.6、数据库只读核验、负向 API、回归测试和备份恢复交叉验证。共归档 72 条截图记录，精选图见 [图文报告](../.local/awwo-saas/acceptance-20260908/acceptance-report.html)。两处新发现的问题已修复并复验；未把未测项或未实现能力判绿。

## 1. 版本与范围

- 工作树：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。
- 分支：`feat/awwo-computer-use-acceptance-20260907`。
- 本轮基线：`8a6975f9e0fcc1bcd321f679a4b6bb09e062e6a8`；最终代码候选：`d04930c1a6e46848c76bef08d807b49e6013aac4`。
- 本轮代码提交：`b8b42fe`（取消历史顺序）、`d04930c`（手机控件布局）。完整文件、SHA256 和树哈希见 [候选追溯](../.local/awwo-saas/acceptance-20260908/candidate-provenance.json)。后端和 Pi 相对基线未改。
- 全套前端回归在历史修复后执行；其后仅增加移动端 CSS，并单独完成静态解析、构建与手机/桌面 GUI 复验。最终文件哈希与这些验证完全一致。
- 环境为本机 development；使用独立随机 schema 和合成账号。模型请求通过用户指定的第三方入口，API 路径为 /v1，模型请求名和运行记录均为 gpt-5.6。证据只能确认该入口以此模型名完成响应，不能独立审计转发站内部的模型路由。
- 原生 Computer Use 尝试遇到 Chrome 无可读截图/可访问性状态后停止；后续实际界面操作由受支持的 Codex 内置浏览器完成。本文不声称原生 Computer Use 全部通过。
- 这是 AwwO Go/Pi SaaS 与相关原画布/Gateway 的验收。继承的 Python 应用、server/ 独立工作区、桌面安装包、MyShell、图像适配器和第三方产品全套测试未运行，见 [独立域盘点](../.local/awwo-saas/acceptance-20260908/backend-legacy-gateway-report.json)。

## 2. 已执行测试

| 范围 | 结果 | 证据 |
|---|---|---|
| SaaS + 原画布扩展 | 65 文件 / 612 测试通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/frontend-fix-saas-expanded.log) |
| 原 Web | 91 文件 / 1,009 测试通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/frontend-fix-legacy-tests.log) |
| 原 Gateway | 36 文件 / 389 测试通过；typecheck / build 通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-legacy-gateway-report.json) |
| Go + PostgreSQL | 26 个顶层 + 22 个子用例；race / vet 通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-summary.json) |
| Pi worker | 22 / 22；语法检查通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-pi-worker.log) |
| SaaS 脚本 / 原启动脚本 | 21 / 21、12 / 12 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-summary.json) |
| Go → Pi SDK → 本地协议服务 | 全栈 1 / 1 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-stack.log) |
| HTTP 负向与恢复 | 14 / 14 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-http-negative-7c9f9f979887-results.json) |
| 前端检查与构建 | 静态检查、SaaS typecheck、SaaS / 原 Web build 通过 | [原始记录](../.local/awwo-saas/acceptance-20260908/frontend-fix-results.json) |
| 本地备份恢复 | 7 项恢复检查通过；14 表 / 35 行逐字段一致 | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-backup-results.json) |
| 真实外部模型 | 10 次受理：9 completed、1 主动 cancelled | [原始记录](../.local/awwo-saas/acceptance-20260908/backend-gui-final-readonly.json) |
| 真实文件下载 | 7 个 JSON 解析及敏感字段检查通过；审计导出 266 条 | [原始记录](../.local/awwo-saas/acceptance-20260908/gui-download-validation.json) |

Web 的 1,009 与 SaaS 的 612 是有重叠的套件，不能相加当作去重总数。已执行的这些自动化套件最终 0 失败、0 跳过，不代表整仓所有独立域都执行。Go 顶层和子用例也分别统计。HTTP / 全栈协议测试使用本地 fixture，与以下真实外部模型证据分开。

SaaS 构建有大 chunk 提示；原 Web 构建另有继承样式与动态导入告警。命令均退出 0。jsdom 的 Window.open 未实现提示属于测试环境；当前浏览器保留日志窗口未发现 error/warn，不代表历史所有请求都没有错误。

## 3. 真实界面与模型链路

1. 用户注册、登录、退出、刷新保留身份；创建与切换独立工作区、修改资料；创建工作区取消不写入。
2. 邀请先预览，暂不加入不自动领用，确认后成为 reader；只读成员可看历史和导出，编辑/运行等入口禁用；reader 访问平台管理被拒。成员角色修改、移除取消再确认、重新添加及撤销邀请已操作。
3. 新建/打开/改名/删除画布；七种模板预览与研发模板 5 节点 / 5 边；搜索、定位、布局和缩放；201 个画布通过真实 UI 翻到第五页。
4. 真实 GPT-5.6 生成两节点一条边的计划，绑定 Pi 后流式运行；同一 Session 两轮记忆正确，刷新仍保留；多 Session 草稿隔离；主动取消后再次运行与刷新恢复。
5. 真实双节点整图先计算 6×7，再将结果交给复核。最终 A 输出 AWWO_0908_OK；6×7=42 原样进入 B prompt，B 成功确认；两个 run 的事件增量、终态和 assistant 消息一致。增量改名及单次撤销也通过。
6. 管理员查看租户、用户、运行、审计；配额 0 被拒，3 / 120 保存；暂停与恢复有审计；四类实际 JSON 导出已检查，审计导出 266 条，UI 审计第六页可达。没有在真实外部模型 active run 期间执行暂停；该分支只在本地后端负向测试中验证。
7. 11 个配色预设、语言和浅深主题切换；配色 Ocean 实际导出；手机 390×843、平板 767×1023 CSS 视口操作与截图。原生自定义颜色保存、配色导入和完整触摸/软键盘验证仍保留缺口。

最终模型数据快照：10 个 run（节点 7 完成 + 1 取消，planner 2 完成），19 条消息、319 个事件；快照时 283 条审计。审计会随后续界面操作增加，此数字是带时间的快照。证据见 [最终只读快照](../.local/awwo-saas/acceptance-20260908/backend-gui-final-readonly.json)、[下载核验](../.local/awwo-saas/acceptance-20260908/gui-download-validation.json)、[审计翻页](../.local/awwo-saas/acceptance-20260908/gui-admin-pagination.json)。

## 4. 本轮发现与修复

| 问题 | 复现与影响 | 修复及复验 |
|---|---|---|
| 取消历史顺序错误 | 取消有部分输出，再发新消息，刷新后旧取消回复追加到最新回复后，导致重复和错误卡片预览 | 按原 user turn 合并；3 个新增用例先复现失败，修复后通过，共增加 4 个回归；重复刷新与真实整图复验通过。截图 48 / 49 / 56 |
| 手机顶部控件覆盖 | 390px 下名称挤成竖排，运行提示覆盖账号区域 | 只改 SaaS 移动断点布局；解析/作用域检查、构建、手机点击账号和桌面复验通过。截图 58（修复前）/ 66–68（修复后） |

详细记录：[历史修复](../.local/awwo-saas/acceptance-20260908/frontend-recovery-fix-report.md)、[手机修复](../.local/awwo-saas/acceptance-20260908/frontend-mobile-fix-report.md)。当前没有从上述最终回归中遗留的失败用例；功能缺口仍见下一节。

## 5. 验收边界与未通过项

| 范围 | 状态 | 事实与影响 |
|---|---|---|
| 工程承建能力 | 未实现 | Pi 目前只运行文本推理，禁用 tools / skills / extensions；没有工程文件落盘、shell 执行或工程产物下载。coding / image 类型名称不代表已有对应执行引擎。 |
| 后台持续整图任务 | 未实现 | 整图调度在浏览器；Go 只持久执行已受理的单节点任务。关闭页面后尚未派发的下游不会自动继续。 |
| 附件与图像 | 未实现 | 文件字段只是引用；未证明文件上传、对象存储、图像生成或下载产物。 |
| 容器交付 | 受阻 / 未执行 | Compose 配置解析通过；本机 Docker daemon 不可达，未实际 build / up，未验收容器内迁移、重启和数据持久性。 |
| 公网 SaaS 上线 | 未执行 | 本轮仅 development / loopback。公网 HTTPS、外层访问门、staging 与 production 资源隔离、发布与生产恢复演练未验收。 |
| 完整 UI 边界分支 | 部分验证 | 配色文件导入、自定义原生颜色输入、完整剪贴板核对、部分多页并发/故障组合、所有触摸和键盘场景仍有缺口；逐项见 57 行矩阵。 |
| 规模与可用性 | 部分验证 | 局部并发、配额、失联、取消、API 重启及本地备份已测；持续负载、多实例扩展、生产 RPO/RTO 未验收。 |
| 账号与商业扩展 | 未实现 | 邮箱验证、找回密码、OIDC、所有权转移、订阅和计费尚无完整实现；这些是能力边界，不擅自扩大为已经确认的商业需求。 |

57 行复合功能的 GUI 状态：PASS 10 / PARTIAL 31 / NOT_RUN 16。这是复合断言覆盖情况，不是单元测试失败数或产品完成百分比。每行都有自动化证据、GUI 证据和剩余断言；见 [完整矩阵](../.local/awwo-saas/acceptance-20260908/acceptance-matrix.json) 与 [范围说明](../.local/awwo-saas/acceptance-20260908/acceptance-scope.md)。

若按最初“多租户公网 SaaS + Pi 工程承建”的全部愿景验收，当前不能签收为全部完成。下一阶段应先补服务端持久整图调度、租户隔离的工程工具/文件执行，再进行容器与受保护 staging 的完整验收；商业账号扩展按确认范围追加。

## 6. 备份恢复与清理

本轮实际 pg_dump custom archive → 独立数据库 pg_restore；14 表 / 35 行完全等值，6 次迁移、19 外键、40 索引、2 序列恢复；恢复后的登录、关联 API 与 SSE 重放通过。临时备份库、dump 和二进制均已清理。该证据不代表生产灾备或大型数据库恢复能力。

本轮真实模型栈清理状态：PASS。测试生成的有效账号凭据不包含在报告/证据包中；模型密钥未写入仓库、报告或截图。真实测试入口只在本机监听。服务、schema 和测试凭据的最终状态见 [运行栈记录](../.local/awwo-saas/acceptance-20260908/live-stack.json) 与 [清理记录](../.local/awwo-saas/acceptance-20260908/final-cleanup.json)。

本轮只在 worker 分支本地提交；没有 merge、push、PR 或部署。原主仓未改动。测试原始日志和截图保留在本机，归档包按白名单选择文件，排除运行脚本、凭据、数据库归档和临时二进制。

## 7. 截图索引

- [真实 GPT-5.6 双节点协作完成](../.local/awwo-saas/acceptance-20260908/56-final-real-dag-pass.png)：计算与复核按依赖顺序执行，2/2 成功；下游输入原样包含上游结果。
- [平台管理与租户配额](../.local/awwo-saas/acceptance-20260908/69-desktop-admin-tenants-final.png)：真实数据库中的三个工作区；验收工作区 A 配额为并发 3 / 每日 120。
- [真实模型运行记录](../.local/awwo-saas/acceptance-20260908/70-desktop-admin-runs-final.png)：9 次 completed 与 1 次主动 cancelled；不能把主动取消计作模型成功。
- [会话恢复缺陷已修复](../.local/awwo-saas/acceptance-20260908/48-fixed-recovery-history.png)：取消的部分输出回到原请求之后，新回复不再被旧记录顶替。
- [再次刷新后的最新预览](../.local/awwo-saas/acceptance-20260908/49-fixed-latest-result-preview.png)：同一 Session 保持 RESUME_OK_0908 为当时的最新结果。
- [真实模型增量修改画布](../.local/awwo-saas/acceptance-20260908/54-planner-modify-applied.png)：只把复核改为结果复核，保留两节点、一条边及绑定。
- [撤销本次规划](../.local/awwo-saas/acceptance-20260908/55-planner-modify-undone.png)：单次撤销后恢复复核名称；后端持久化记录支持此结果。
- [已撤销邀请被拒绝](../.local/awwo-saas/acceptance-20260908/52-revoked-invite-rejected.png)：撤销后访问链接，确认加入不可用。
- [取消创建工作区](../.local/awwo-saas/acceptance-20260908/57-workspace-create-cancelled.png)：输入测试名称后取消，原有两个工作区保留且未新增。
- [审计记录超过 200 条仍可访问](../.local/awwo-saas/acceptance-20260908/72-admin-audit-page-six.png)：实际点击第 2 至第 6 页，逐页记录页码。
- [手机登录入口](../.local/awwo-saas/acceptance-20260908/39-mobile-login-calibrated.png)：实际 CSS 视口 390×843；截图像素受设备比例影响，不把像素尺寸冒充 CSS 视口。
- [手机顶部布局修复后](../.local/awwo-saas/acceptance-20260908/66-mobile-header-fixed.png)：工作区名称横向显示，账号和退出入口可见，运行提示不再覆盖。
- [手机账号面板可操作](../.local/awwo-saas/acceptance-20260908/67-mobile-account-fixed.png)：修复后点击账号，正确打开包含资料和成员的面板。
- [手机助手输入](../.local/awwo-saas/acceptance-20260908/63-mobile-planner-input.png)：实际输入，未为此额外调用模型；完整触摸和软键盘仍未验收。
- [手机会话输入](../.local/awwo-saas/acceptance-20260908/65-mobile-session-input.png)：会话展开后可输入；历史来自真实 Go/Pi 运行。
- [桌面布局复验](../.local/awwo-saas/acceptance-20260908/68-desktop-after-mobile-fix.png)：移动端 CSS 修复后，桌面画布控件和节点继续可见。

截图为实际界面采集，未生成或修饰。部分早期截图受浏览器截取比例影响或只记录过渡状态，未用来证明最终成功；正式图文报告优先展示完整页面截图。截图 23 与 64 不计作其文件名暗示的完成证据。
