# Roadmap: Workspace 侧栏分组与权限解耦（Plan A+）

- 状态：已规划（2026-06-13），Codex (gpt-5.5) + Gemini 对抗评审均 **同意 Plan A+、反对退回双概念**
- 依据 ADR：`docs/workspace-trust-container.md`（workspace = 唯一信任容器，已 ship 进 `main`）
- 触发：真机 Super App 暴露三个 UX 缺陷（见 §1）

---

## 1. 背景：已 ship 的内核 + 暴露的 UX 缺陷

workspace trust container 已落地（内核/CLI/API/Web 全链路，已在 `main`）。但真机使用暴露出**把"会话分组"和"公司执行边界"在 UI 上焊死**的副作用：

1. **新对话被吸进公司 workspace**。根因：Web 每个 chat turn 硬编码 `repo_path: '.'`（`apps/web/src/App.tsx:6564/7218`）→ 解析到 dev server 的 cwd → 命中"恰好绑定了该目录"的公司 workspace（如 "LEONNEWS HQ"）。随手聊天因此被归进公司。
2. **公司 workspace 漏进聊天侧栏**。根因：`build_workspace_inventory`（`ui_contracts.py`）`list_workspace_profiles()` **无 company 过滤**，把公司的执行边界当成聊天分类暴露出来。
3. **无法像 Codex 那样自建个人 workspace**；"收件箱"文案别扭（应为"聊天"）；无归档功能。

---

## 2. 概念错位与修正方向（顾问共识）

**错位**：第二轮把 workspace 在内核合并成"信任+分组"单一概念——这对**治理是对的**（不能让 agent 在未信任目录执行），但侧栏 UX 把权限变化伪装成了普通文件夹操作。

**修正（不退回双概念）**：把**内核概念**与**侧栏视图**分开——
> 内核里 workspace 仍是唯一信任容器；聊天侧栏是一个**个人视图**，只展示个人聊天上下文，公司/agent workspace 不进此列表（归 Team 工作台）。侧栏每一项底层仍是真 workspace（碰文件时信任门照常生效），只是看不到公司那些。

Codex 原话："不是回滚，而是把'workspace 是执行容器'贯彻到底，避免侧栏 UX 把权限变化伪装成普通文件夹操作。"
Gemini 原话："通过 Kind + 视图过滤解决全部痛点，同时守住 fail-closed 底线。"

---

## 3. 核心模型：一个内核概念 + 两种 kind + 双表面视图

`WorkspaceKind` 枚举已存在（PR-1：REPO / MANAGED / REMOTE），无需新增实体。

| kind | 信任 | 权限 | 角色 |
|---|---|---|---|
| **REPO** | 必须 trust-as-creation | 真实 `writable_paths`（repo 内） | 绑真实目录，分组与权限重合（Claude Code 模型） |
| **MANAGED**（folder / Chat） | 免信任（app 自建目录，trust-by-construction） | **锁死在 `~/.superclaw/.../<id>`，禁全局写/shell** | 本质纯分组文件夹（Codex 式个人 workspace） |
| REMOTE | 预留 | 预留 | 未来远程/沙箱 |

### 分组 vs 权限关系（举例）

- 你点 **`+ 新建 workspace`** → 建一个 MANAGED 草稿区 → 它是个"零权限聊天文件夹"，agent 在里面**碰不到你的真实文件**（写权限锁死在它自己的 scratch 目录）。
- 你点 **"接入代码库" 选 `~/code/myapp`** → 弹 trust 确认 → 建一个 REPO workspace → 现在这个 workspace 里的对话**能读写 `~/code/myapp`**（且只能这个目录）。
- **同一个对象**：建文件夹时退化成零权限草稿，接入 repo 时才长出真权限。"分组"是你看到的，"权限"是它绑定的目录给的。
- 公司 "LEONNEWS HQ" 的 workspace（`company != "local"`）是 agent 跑 issue 的执行边界 → **只在 Team 工作台显示，不进聊天侧栏**。

---

## 4. 阻断项（两路顾问都点名，必须做）

1. **纯聊天必须发 `repo_path=null`**（而非 `'.'`），才会落 managed Chat workspace 而不是 cwd 的真实 workspace。← 真正根因，光过滤视图不够。
2. **聊天侧栏只拉 `company="local"` 的 workspace**；公司 workspace 不仅不显示，也不能被个人聊天的"继续/移动"默认命中。
3. **MANAGED folder 必须是锁死的 scratch**：`writable_paths` 锁在独立 scratch 目录，禁全局文件写/shell——否则是"带枪的暗箱"。
4. **REPO 个人 workspace 仍必须 trust**，不能因为 `company="local"` 就静默创建。规则：`新建 workspace`=默认建 folder-only scratch；`接入 repo/folder`=触发 trust 确认。
5. **会话移动不是 Codex 式无害**：移进 REPO workspace = 权限/上下文变化。必须 ① UI 警告"后续将在该 workspace 执行" ② 重建/清理 native binding，防旧 runtime 在旧 repo resume。
6. **列表默认过滤 `archived=false`**。

---

## 5. 分阶段路线图

### PR-A（内核）：archived 字段 + 个人 workspace 创建 + 移动语义
- `ChatSession.archived: bool`（顶层字段；`chat_sessions` 视情况加列，列表默认过滤）。
- `state.set_chat_session_archived(session_id, archived)`。
- `workspace_resolver.create_personal_workspace(name, *, attach_repo=None)`：
  - `attach_repo=None` → 建 MANAGED scratch（`~/.superclaw/workspaces/<id>`，`company="local"`，trust=active，`writable_paths` 锁死）。
  - `attach_repo=<path>` → 走 `create_trusted_workspace`（REPO，需调用方已确认）。
- `set_chat_session_workspace` 移动时：若目标为 REPO 且与原 workspace 执行边界不同 → 标记 native binding 失效（下一轮重建），并在返回值/事件里携带"执行边界已变"提示。
- 测试：scratch 写权限锁死、folder 免信任 vs repo 必信任、archived 过滤、移动重建 binding。
- 验收：Codex + Gemini 双 PASS → 原子提交。

### PR-B（API + 契约）
- 纯聊天 `repo_path=None` 路由到 Chat workspace（确认 CLI/API 同一 resolver）。
- `build_workspace_inventory` / `list_chat_sessions` 默认 `company="local"` + `archived=false`；公司 workspace 走 Team 投影。
- 新端点：`POST /api/workspaces`（建个人 workspace，folder/attach 两档）、`POST /api/chat/sessions/{id}/archive`、`POST /api/chat/sessions/{id}/move`（移动，repo 目标返回执行边界变更提示）。
- 测试 + 双 PASS。

### PR-C（Web 侧栏）
- 侧栏结构：`[+ 新建 workspace]` + 会话列表（默认 Chat workspace 会话平铺；用户建的 workspace 显示为可折叠分组）。
- `+ 新建 workspace`：默认建 folder；"接入代码库"入口触发 trust（PENDING → Trust Barrier）。
- 移除公司 workspace（只渲染 `company="local"`）。
- 文案：`收件箱 → 聊天 / Chats`。
- 归档：右键/菜单归档、"显示已归档"开关。
- 移动：会话"移动到 workspace"，移进 repo workspace 弹警告。
- 纯表现层，只消费契约；`npm test` + build + 双 PASS。

### PR-D（CLI 对齐，可选同轮或紧随）
- `superclaw workspace create --folder <name>`（建 personal scratch）；`workspace archive/unarchive <session>`；移动命令对齐 API 语义。保持 CLI=内核基准、零偏差。

---

## 6. 明确不做 / 取舍

- **不退回双概念**（双顾问明确反对）。
- 不把 REMOTE kind 这轮做。
- 移动的"路径关联断裂"这轮用**警告 + native binding 重建**兜底，不做自动路径迁移（过度工程）。
- 公司 workspace 的 Team 工作台呈现沿用现有 company 目录，不在本路线图扩展。

---

## 7. 验收与留痕

- 每个 PR 走 `codex-cli-advisor`(gpt-5.5) + `gemini-cli-advisor` 对抗验收，双 PASS 才提交；Gemini 配额 429 时用 `antigravity-cli-advisor`(agy) 替补第二视角。
- 顾问 transcript 落 `.codex-cli-advisor/` / `.gemini-cli-advisor/`。
- 重大结论同步项目记忆（`workspace-session-grouping-design` / `workspace-implementation-progress`）。

---

## 8. 侧栏「项目/聊天」两段式重构（2026-06-20，已落地）

真机反馈现有侧栏的独立大「New workspace」按钮"没有意义"。重构对齐 Codex 习惯：

- **IA**：侧栏天生分「项目(Projects，上) / 聊天(Chats，下)」两大类。项目区头 hover 出 `+` 建项目（取代独立大按钮，inventory 缺失的回退态除外）；每个项目组头 hover 出 `+` 在该项目内开对话；空项目立即显示。
- **项目内开对话**：复用内核既有 `ChatTurnRequest.workspace_id` + CLI `chat --workspace <id>`，纯表层零内核改动。
- **composer workspace 选择器**（Codex 式）：新对话(无绑定会话)可在 composer 选「Chat(无项目)」或任一项目；未信任项目 disabled。
- **执行边界单一派生（核心不变量）**：每个 turn 的 workspace 由「会话真实绑定」权威决定——带 session id 的 turn 绝不读 UI pin；confirmed 会话以 `backendChatSessions` 绑定为准（移动到 B / 移动到无项目都被尊重，stale pin 与旧创建映射都拽不回）；未知/未信任 workspace_id 一律原样发出由内核 fail-closed（403/404），绝不前端降级到 server cwd；仅「全新草稿」用 pin，乐观 lag 用 `chatSessionWorkspaceRef` 创建映射。

### §4.1（纯聊天 `repo_path=null`）的处置 —— 已由 PR-B 完成（2026-06-20）
- **铁律核实**：CLI `chat` 的 `--repo` 默认曾是 `Path(".")`（`cli.py`），即 CLI 纯聊天也发 cwd。故侧栏 PR 当时保持 Web `repo_path:'.'` 与 CLI **完全 parity**；单改 Web 会违反"CLI/Web 零偏差"铁律。
- **PR-B 落地**：纯聊天默认改为落受治理的 managed Chat scratch（`~/.superclaw/chats`），**CLI + Web + API 协同**：
  - CLI `chat --repo` 默认 `Path(".")` → `None`（`shell`/`run` 不改）；`_execute_chat_turn` 在 repo 为 None 时按 **session 自身 workspace** 派生执行目录并重走 trust gate。
  - Web flat 聊天 `repo_path:'.'` → `null`；flat **delivery** 保持 `'.'`（与 home delivery 一致，delivery 操作真实树）。
  - API `resolve_chat_session` 把 repo_path 回填**移到 session 确定之后**，同样按 session workspace 重走 trust gate（quarantined/已删 → 403/404 fail-closed；legacy `workspace_id None` → 降级 Chat scratch）。
- 内核 `ensure_chat_workspace` 早已就绪，无需改。三轮 Codex(gpt-5.5)+antigravity(Gemini 3.1 Pro) 对抗验收，逐轮抓出真 bug（CLI/API 续接项目会话落 scratch、flat delivery 分裂、legacy/已删 workspace_id KeyError 崩溃、trust 门没跟 session），R3 双 PASS。
- 侧栏 PR 本身的验收：五轮对抗，逐轮抓出真 bug（执行边界丢失 / stale-pin 搬移 / 创建映射覆盖绑定 / untrusted 降级绕 trust gate / unknown 降级 cwd / 移动后 refetch 失败被搬回），R5 双 PASS。

---

## 9. 个人项目目录可见化（Codex 真文件夹模型，2026-06-21 落地）

业主诉求：「新建项目」应像 Codex 那样产生一个**真实、命名、Finder 可见、用户拥有**的文件夹（不存在则创建），而非现状不透明的 `~/.superclaw/workspaces/<id>` scratch。

**定稿设计（四轮方案对抗验收，Codex+antigravity 双 PASS；符合 ADR L34/L51 managed 构造信任、L44 仿 Codex 文件夹、L60 危险根禁令）：**

- **保持 `kind=MANAGED`、trust 构造信任 ACTIVE、`writable_paths=["."]` 锁死**——不改 kind（避 REPO 语义冲突/指纹漂移），**只把 `repo_path` 从隐藏 `~/.superclaw/workspaces/<id>` 改为可见 `~/SuperClaw/<slug>`**（env `SUPERCLAW_PROJECT_ROOT` 可改根）。新字段 `metadata.creation_mode="real_folder_v1"` + `dir_pin={dev,ino}`。
- **fd-relative race-free 创建**（`create_managed_project_dir`）：`realpath` 先解析根的合法 symlink 前缀（修 macOS `/tmp→/private/tmp`）→ 逐级 `O_NOFOLLOW` 走查（拒 symlink + 拒 group/world-writable 祖先，leaf/root 须 owner==uid）→ `os.mkdir(slug, dir_fd=root_fd)` 原子建 → `fstat` pin inode。
- **砍任意 `path` 免审**（堵后门）：自定义位置 / 接入已有文件夹一律走「接入已有目录」（attach + `trust_confirmed` 人审）。
- **执行复核 choke point**（`assert_execution_repo_safe` / `assert_managed_dir_unchanged`）：两个内核执行汇聚点——`orchestrator._execute_run`（run_goal：CLI chat/delivery）与 API `_guard_chat_containment`（direct/native chat）——在 backend 用 cwd 前重校验 inode，`WorkspaceDirCompromised` → fail-closed（绝不重建）。`WorkerLimits.protected_cwd` 让 backend 对真实 project 不 `mkdir` 重建。
- **冲突 fail-closed**（已存在=拒，never adopt）；**存量旧 scratch（无 `real_folder_v1` 标记）零迁移**，继续在其 scratch 跑。
- **残留**：执行复核→子进程 chdir 的毫秒级 TOCTOU 仅同 uid 可利用（=主机已失陷，父目录 `mode&0o022==0`），Codex+antigravity 均判可接受，不为子进程传 fd（过度工程）。
