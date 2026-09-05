# Agent Company — 前端 UI 完整设计规格

Status: 设计定稿（与 execution-plan §2.6/§2.7 五轮裁决一一对应；实现归 P1d/P2）
Date: 2026-06-10
关系：本文是 `agent-team-kernel-execution-plan.md` 的 UI 设计篇——把 typed issue、审批冒泡、委派树、成本账本、manager loop 全部翻译成**具体页面、布局、交互与 API 绑定**。实现时以本文为准,不再即兴设计。

---

## 1. 定位与铁律

- **表层定位**：UI = Super 内核的「公司工作台 + 审批收件箱 + 成本仪表盘」。零新增语义;所有 mutation 只走 `/api/team/*`、`/api/cost/*`;每个按钮都有等价 CLI 命令(界面上可悬停显示)。
- **三条交互铁律**：
  1. 前端不自己算业务(谁能管谁、能不能委派,只读内核字段渲染);
  2. 乐观更新只允许显示 Pending/Submitting,**绝不乐观显示"已授权/已完成"**;
  3. 凡 fail-closed 的拒绝(锁冲突 409/装备 dropped/审批 pending),UI 必须**显示原因**,不准静默吞。
- **视觉基调**：沿用现有黑白设计 token(`--bg-base/#fff`、`--text-primary/#111`、`--border-light/#e7e7e7`、`--shadow-soft`,Linear 风),Paperclip 移植件全部改皮到这套 token。暗色跟随现有 ThemeContext 机制。双语(en/zh)沿用 SHELL_COPY 模式。

## 2. 信息架构与导航

```
左侧 rail(现有)                     主区
  插件市场                          ┌ Team 工作台(workspaceSurface='team') ───────────┐
  Agent 组  ←入口                   │ 顶栏: 公司切换器 ▾ · KPI 条 · ⌘K 命令面板        │
  新建会话                          │ 二级 tab: 总览 | 组织 | 工单 | 审批 | 成本        │
  会话列表…                         │ ┌─────────────────────────────────────────┐ │
                                    │ │  当前 tab 内容(下文 §3 逐页设计)            │ │
  空公司状态: 点「Agent 组」直接     │ └─────────────────────────────────────────┘ │
  进入 BootstrapWizard(§3.1)        │ 右侧滑出层: AgentDetail / IssueDetail 抽屉      │
                                    └──────────────────────────────────────────────┘
```

- **代码结构**(拆 App.tsx 巨石):
```
apps/web/src/team/
  api.ts          # /api/team/* /api/cost/* 的全部 fetch hooks(唯一写入口)
  types.ts        # 与 ui_contracts payload 对齐的 TS 类型
  TeamWorkspace.tsx   # 壳: 公司切换器+KPI+tab 路由
  BootstrapWizard.tsx · OrgChart.tsx · AgentDetailDrawer.tsx
  IssueBoard.tsx · DelegationTree.tsx · ApprovalInbox.tsx · CostOverview.tsx
  IssueDetailDrawer.tsx(P2) · components/(基元)
```

## 3. 页面逐项设计

### 3.1 BootstrapWizard — 建公司向导(P1d 第一屏)
移植 Paperclip OnboardingWizard 的 4 步壳(步骤指示器: 公司→CEO→任务→Review),**语义改为 proposal+人审**:

- **Step 1 公司**：公司名*(必填)、目标(textarea)。`下一步`仅本地暂存,不落库。
- **Step 2 设计 CEO**：名称(默认 CEO)、backend 下拉(claude 默认/codex/gemini,只列内核 `/api/backends` 返回的)、**Charter 编辑器**(markdown textarea,带模板按钮"从 AGENTS.md 导入"→文件选择;预填一段默认 CEO charter:"委派而非亲自写码,用子任务派活,阻塞要标 owner")、persona 一行、装备申请(多选,来源 `/api/team/agents` 同款 plugin 列表)、预算(budget_seconds + token_budget,默认低值)。
  - **实时装备预演**:选择装备时右侧即时显示 `granted ✓ / dropped ✕(原因) / pending_approval ⚠`(调 resolve 预览接口或前端按 bootstrap preview 返回渲染)。
- **Step 3 播种首任务**：标题(默认"组建团队并产出执行计划")、描述(自动伸缩 textarea)。
- **Step 4 Review & Commit(关键差异页)**：
  - 整单蓝图卡:将创建 1 公司/1 工作区/1 CEO/1 issue 的清单;
  - **高危逐条列表**(红边卡):每条= 权限名+原因+影响("写路径越界 src/ 以外"/"网络扫描"/"未签名插件 x");
  - 预算 clamp 结果("申请 600s → 生效 300s,受 company 默认约束");
  - 主按钮 `提交蓝图`→ `POST /api/team/bootstrap (mode=proposal)`。
- **锁屏态(提交后)**：全屏居中卡片——"等待授权 · 在终端运行:`superclaw approve <approval_id>`"(命令可一键复制);轮询/SSE 等 approval 状态,`approved`→自动进 Dashboard 并播一次成功 toast;`rejected`→回 Step 4 显示 decision_note。
- 空公司时此向导即 Team 入口的默认页;已有公司则在公司切换器里有"➕ 新公司"。

### 3.2 TeamWorkspace 总览(Dashboard)
- **KPI 条**(4 格,小数字+趋势): 角色数 · 工单(按状态着色的迷你条形) · 待审批数(红点) · 今日成本(tokens+时长,点击跳成本页)。数据= `/api/team/inventory` + `/api/cost/summary`。
- **进行中委派树速览**:若有 live run,显示 DelegationTree 缩略(§3.6);无则空态插画+"给 CEO 一个目标"快捷输入(创建 root delivery issue 并可一键 assign CEO)。
- **最近审批/最近完成** 两列卡片流。

### 3.3 OrgChart — 组织图(P1d)
移植 Paperclip `layoutTree/layoutForest` 纯布局算法(627 行,改皮):
- 画布: pan/zoom(0.2–2x)、触屏捏合;多根森林布局。
- **节点卡(200×100)**: 名称+role 徽章、状态点(active/运行中=呼吸绿点)、**装备计数徽章**("⚙ 3"=granted 数,悬停列出 granted/dropped)、charter 摘要首行(灰字截断)。
- 连线=`reports_to`(只读渲染,**委派方向箭头**上→下)。
- 点击节点→ AgentDetailDrawer;空态→"还没有角色"+ 建角色按钮。
- 顶部工具条: 适应窗口/导出 PNG。

### 3.4 AgentDetailDrawer — 角色详情抽屉(右滑 480px)
Tabs(砍 Paperclip 的 Billing):
- **Charter**(默认 tab): persona 行 + charter markdown 渲染 + `编辑`(textarea→`agent update-charter` 等价 API,保存后显示新 charter_revision_id);charter_source 徽章(manual/template)。
- **装备**: 三段列表 granted ✓(绿)/dropped ✕(灰+原因 tooltip)/requested ⚠;底部说明文案"装备只能在治理投影内收窄,提权需审批"。
- **配置**: role/title/backend/预算(time+token)/reports_to(下拉只读显示,改动走 API);
- **运行**: 该 agent 的 run 列表(时间/状态/成本),点击跳 DelegationTree 对应节点;
- **成本**: `/api/cost/summary?agent=` 迷你汇总(tokens 曲线 P2)。

### 3.5 IssueBoard — 工单看板(P1d)
现有 TeamWorkbench 看板升级:
- 列: `待办(backlog) · 就绪(todo) · 进行中 · 待返工(needs_changes) · 评审中 · 完成`。
- **卡片**: 标题 + **kind 徽章**(delivery=黑底/delegation=蓝边/review=黄边/bug=红边) + review_policy 角标(human_final 显示 👤,parent_accept 显示 🤖) + assignee 头像字母 + 父子指示(└ 委派自 #issue 短号,点击高亮父卡) + 成本小字(该 issue 累计 tokens)。
- delegation/bug 子卡**缩进嵌挂在父卡下**(树式看板,折叠按钮),而非散落各列——这是和 Paperclip 平铺看板的关键差异,呼应"子 issue=审计 Span"。
- 交互: 与 Phase 1 相同(分派/签出/提审按钮按状态出现),但 **delegation issue 不显示"提交评审"按钮**(机器流转,显示"由父验收"灰标);root delivery 的 `通过`走人审。
- 顶部过滤: kind / assignee / workspace。

### 3.6 DelegationTree — A2A 实时执行视图(P1d 核心新视图,Paperclip 没有的差异化)
**这是整个 UI 的灵魂页**:可视化"CEO 委派 Eng→QA 打回→Eng 修复"这条链。
- 布局: 左侧纵向树(root run 在顶),节点=agent 头像+名字+当前状态(thinking/delegating/executing/done/failed)+实时秒表+token 计数(SSE 驱动,来源现有 `/api/runs/{id}/events` + cost 事件)。
- 委派发生时: 父节点旁滑出新子节点+连线动画;**审批冒泡**时整树变灰冻结+root 顶出红色审批条(点击进 ApprovalInbox 对应项)。
- 右侧详情面板: 选中节点显示**压缩回流摘要**(status/summary/affected_files/cost——正是 §2.7 的 resume payload,UI 直接渲染该结构)+ 该节点 CostEvent 列表。
- **人类中途介入控件**(节点悬停): `⏸ 暂停 · ✖ 取消 · 💬 插话`(插话=resume with instruction,弹输入框,等价 CLI `superclaw run resume --with-instruction`)。P1d 先做暂停/取消,插话 P2。
- 树底状态栏: 深度 x/3 · 本轮 manager round x/max · 树累计成本。

### 3.7 ApprovalInbox — 审批收件箱(P1d)
移植 Paperclip 多态 payload 渲染模式,映射我们四类:
- 列表: pending 默认 tab(红点计数)/全部 tab;卡片=类型图标+一句话标题+请求者+时间+**成本快照**("申请时已花 12.3k tokens")。
- **多态详情**:
  - `issue_completion`: 工单摘要+evidence 链接+委派树终态缩略图;
  - `permission_grant`: 权限 diff 表(申请→生效,高危行红底)+影响范围(affects 渲染);
  - `budget_override`: 当前消耗 vs 上限的 burn 条+申请增量;
  - `bootstrap commit`: 整单蓝图(§3.1 Step4 同款渲染)。
- 决策条: `通过`(主黑钮)/`驳回`(必填 note)/`要求修订`(P2)。**点击后按钮锁定为 Submitting,等 200 才更新状态**(铁律 2)。
- 冒泡审批特别标识: "🧊 此审批冻结了一棵执行树(N 个 agent 等待中)"+跳转 DelegationTree。

### 3.8 CostOverview — 成本视图(P1d 基础/P2 完整)
- 顶部三格: 总 tokens(input/output/cached 分段条)·总时长·事件数;`usage_status` 构成条(actual 绿/unavailable 灰/not_applicable 白)——**诚实呈现"哪些钱是估的"**。
- 维度切换 tab: 按公司/按 agent/按 issue(含返工归因,靠 root_issue_id 聚合)/按 provider。
- 列表行: scope 名+tokens+时长+事件数,点击展开 CostEvent 明细表(时间/run/任务/usage_status)。
- P2: 时间趋势面积图、预算 burn-down(软告警黄线/硬停红线)、chat 会话成本侧栏挂件(聊天页右上角小徽章"本轮 1.2k tokens")。

### 3.9 IssueDetailDrawer(P2,聊天式)
移植 Paperclip IssueDetail 布局: 上=issue_events 时间线(comment/question/bug_report/status_change/delegation 各有图标与配色,delegation 事件内嵌子卡),下=composer(评论/@角色),右=属性面板(kind/review_policy/assignee/父子关系/成本)。P1d 不做,IssueBoard 卡片点开先用简版(属性+events 只读列表)。

### 3.10 通用状态设计
- 空态: 插画+一句引导+主操作按钮(每页定制文案);加载: skeleton(列表行/卡片/树节点三种);错误: 顶部红条显示内核原因+`重试`;所有 409/403 用内核 detail 原文。
- ⌘K 命令面板(P2): 移植 Paperclip command palette,动作=各页主操作+跳转。

## 4. 页面 ↔ API 契约映射

| 页面 | 读 | 写 |
|---|---|---|
| BootstrapWizard | /api/backends · catalog preview | POST /api/team/bootstrap · approve 经 CLI/收件箱 |
| 总览 | /api/team/inventory · /api/cost/summary | — |
| OrgChart | /api/team/inventory(agents+reports_to) | — (只读) |
| AgentDetail | /api/team/agents/{id}(含 equipment) · /api/cost/summary?agent= | POST /api/team/agents · update-charter 端点(P1d 补) |
| IssueBoard | /api/team/issues(+kind/review_policy 字段) | assign/checkout/submit/delegate 现有端点 |
| DelegationTree | SSE /api/runs/{id}/events · /api/cost/events?run= | pause/cancel/resume 端点(P1b 内核命令的 API 化) |
| ApprovalInbox | /api/team/approvals(+cost_snapshot) | approvals/{id}/grant|reject |
| CostOverview | /api/cost/summary · /api/cost/events | — |

## 5. 范围切割(与 execution-plan P1d/P2 对齐)

- **P1d(最小可信前端)**: BootstrapWizard 全流程(含锁屏)· OrgChart 只读 · IssueBoard(typed 卡片+树式嵌挂) · ApprovalInbox(四态多态渲染) · DelegationTree(树+SSE+暂停/取消) · CostOverview 基础。
- **P2**: IssueDetail 聊天式 · 插话介入 · 成本趋势/burn-down/chat 挂件 · ⌘K · 要求修订 · team scratchpad 视图。
- **不做**(与砍单一致): 成员/邀请/RBAC 页 · Secrets 页 · InstanceSettings · routines 页(P3 另议) · 拖拽改组织图(reports_to 改动走表单+审计)。
