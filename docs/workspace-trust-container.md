# ADR: Workspace 即信任容器（Trust Container）—— 会话分组、权限边界与项目容器的统一

- 状态：已裁决（2026-06-12，两轮 Codex gpt-5.5 + Gemini 对抗评审均 PASS，用户拍板）
- 关联：`docs/unified-task-entry.md`、`docs/agent-team-kernel-execution-plan.md`
- 参考实现调研：Paperclip / Codex（CLI 源码 + 桌面 app 行为）/ Hermes / OpenClaw / Claude Code（本机实测）

## 1. 决策一句话

**SuperClaw 只有一个 workspace 概念：升级现有 `WorkspaceProfile` 为 "repo 锚定的信任容器"——它同时是 session 的分组容器、权限/执行边界、项目默认配置的载体；Company 是 workspace 之上的组织层（个人场景由隐式 `"local"` 公司兜底，用户无感知）；纯聊天落在内置的托管 Chat workspace，而不是"无归属"。**

## 2. 背景与问题

Chat session 此前是纯平铺列表，与项目/repo 无关联；而 Team Kernel 已有 `CompanyProfile` / `WorkspaceProfile`（执行边界）/ `Issue`（已归属 workspace）。需要回答：会话如何按项目分组？分组容器与治理边界是一个东西还是两个？company 与 workspace 什么关系？

### 参考实现的共性结论

| 实现 | 容器模型 | 关键机制 |
|---|---|---|
| Claude Code | project = 目录，唯一概念 | project 条目携带 allowedTools（权限）+ trust 门 + session 分组 + 记忆；**trust 对话框 = 容器诞生仪式** |
| Codex CLI | 无显式 workspace，cwd 即项目 | SessionMeta 记 cwd+GitInfo；resume 按规范化路径过滤（--all 绕过） |
| Codex 桌面 app | **专门的聊天 workspace** | 非项目对话自动落 `~/Documents/Codex/<日期>/<slug>/` 托管目录（本机 169 个会话实证） |
| Paperclip | Company → Project → Workspace（模板/实例两层） | 开项目时附 repo，**自动物化托管 checkout**；issue 执行按项目策略全自动选执行目录 |
| Hermes | 无 workspace 表 | title/source/parent 链弱分组；记忆按 per-directory 聚合 |
| OpenClaw | workspace = agent 家目录 | 身份/记忆/指令的持久层，session 按来源 scope 分组 |

共性：workspace 携带"工作目录 + 指令文件 + 默认配置"，session 创建时继承；按项目过滤会话列表是共同 UX 原语；**手动动作最多一次（trust / 开项目），之后全自动**。

## 3. 概念模型（裁决结果）

```
Company（组织层：agents 名册、预算、公司级策略；个人场景隐身为 "local"）
  └─ Workspace（唯一容器 = trust + 权限边界 + session 分组 + 默认配置）
       ├─ kind=repo     ：锚定用户真实 repo，trust-即-创建
       ├─ kind=managed  ：app 托管目录（内置 Chat workspace、公司物化 checkout），trust 天然 ACTIVE
       └─ 工作线程（同一种东西，统一 activity 视图）：
            ├─ ChatSession（人驱动）
            └─ Issue → run（agent 驱动；issue 本就归属 workspace）
```

硬性裁决：

1. **不新造第二个实体。** 不存在独立的 "ChatWorkspace/Project" 分组容器；分组与治理是同一个 `WorkspaceProfile`（第一轮"双实体"方案在第二轮被用户需求变更与 Claude Code 证据推翻，双顾问正式收回）。
2. **Company 不是 workspace，也不可砍。** 跨 repo 预算、公司级插件/高危策略需要承载主体；`1 company → N workspaces`；`WorkspaceProfile.company_profile_id` 默认 `"local"` 让个人用户永远不接触 company。
3. **每个 session 永远有 workspace_id，内核无 null 分支。** 无 repo 的纯聊天落内置 Chat workspace（managed 托管草稿区，仿 Codex 桌面 app 的 `<日期>/<slug>/` 结构），写权限仅限该目录——比"零信任 Inbox"更优：聊天保有产出 artifact 的能力，且消灭了 `workspace_id=None` 特殊分支的逃逸面。
4. **issue 即 workspace 内的工作线程。** issue 的 run 与 chat 同住 workspace、同记一本成本账（models.py 既有世界观："Chat, single delivery, and team-member runs are all the same thing"）；UI 做统一 activity 投影，但内核不把 issue-run 强行改造成 ChatSession。

## 4. Trust-即-创建（仿 Claude Code）

- **CLI（交互）**：首次在某 repo 发起 chat，按 repo 身份解析后若无匹配 workspace，弹确认"信任此目录并创建 workspace"；接受即建（一次性）。
- **非交互路径（API/Web/后台/管道）**：**fail-closed**，返回 `WORKSPACE_TRUST_REQUIRED`，绝不静默创建。Web 对 PENDING_TRUST 的 workspace 呈现全屏 Trust Barrier，不直接渲染聊天框。
- **managed 目录例外**：app 自有目录（Chat workspace、公司物化 checkout）不含用户既有数据，trust 由构造保证（ACTIVE），零确认。
- **UI 语义**：全链路使用"接入/信任代码库"强语义，禁止"新建聊天分组"类软词汇（防止用户为整理聊天误建权限边界）。

### Repo 身份归一（防 worktree 分身）

`repo_identity` 指纹 = **remote URL 与 git common-dir 的联合 key**（两者都参与，缺 remote 时退化为 common-dir，非 git 退化为规范化路径）。worktree 共享 common-dir 故归一到同一 workspace；同 remote 的独立 clone（含保留 origin 的模板仓库）common-dir 不同，保持独立——并防止"伪造 origin 指向已信任 remote 即可绕过 trust"的攻击。**checkout_path 单独记录**（写权限与 native session 仍按实际路径；消费方取当前物理路径必须读 `WorkspaceResolution.identity["canonical_path"]`，不读 `workspace.repo_path`）。

### 危险目录黑名单（内核硬编码）

禁止以文件系统根、用户 HOME、Desktop/Documents/Downloads 等顶级目录直接 trust 建仓；要求目录具有工程特征（如 `.git`）或走 managed 托管。防"在 `~` 顺手按 Y → agent 可写 `~/.ssh`"的爆炸半径。

## 5. Schema 决策（顶层化，不塞 metadata）

| 对象 | 新增 | 说明 |
|---|---|---|
| `ChatSession` | `workspace_id`（顶层字段 + **chat_sessions 表可索引列**） | 列表过滤/排序不允许全表扫 JSON payload |
| `WorkspaceProfile` | `kind`（repo\|managed\|remote 预留）、`trust_status`（pending_trust\|active\|quarantined）、`trusted_at`、`trust_source`、`policy_version`、`repo_identity` | 权限每次扩大 bump `policy_version`，并使 native session / capability surface 守卫失效重建 |
| `default_permission_policy` | 类型化槽位：`permission_mode_default`、plugin allowlist、MCP allowlist、approval policy | 权限管理后做，但槽位现在预留 |
| `RunSession.execution_context` | `workspace_id` + `workspace_policy_snapshot` | 历史 run 锁定执行时策略快照，审计不可变；session 在 workspace 间移动只改分组、不重写历史 |
| `CostEvent` | `workspace_id` 独立列 + 查询 filter | 现仅在 payload，无法可信聚合（独立任务跟进） |
| `ui_contracts.py` | workspace 投影：名称/kind/trust_status/repo 证据/权限摘要/统计 | 表层只消费契约，禁止自行推断组织语义 |

同时收紧 `_assert_governance_scope` 的 free-form workspace key 旁路（single-tenant MVP 的故意放行，与"workspace=统一权限容器"直接冲突）。

## 6. 归属与移动规则

- 归属：显式（`--workspace`）> repo 指纹推断（建议+确认，不静默自动建）> Chat workspace 兜底。**显式 `--workspace` 只决定分组归属，绝不豁免执行目录的 trust 校验**——执行 repo 必须本身被某个已信任 workspace 覆盖。
- `chat --continue` 默认只在当前解析出的 workspace 内找最近 session（Codex resume 语义），`--all` 绕过。
- session 可在 workspace 间移动：**纯分组移动**——历史 run/CostEvent 的治理戳记不可变；移动后下一 turn 重新 resolve repo/native binding（必要时退休 native session）。
- 存量平铺 session 迁移：`workspace adopt` 按 `native_sessions` 已记录的 repo_path 回填，每条带证据，不静默批量。

## 7. 公司侧（Paperclip 模式）

开公司向导折叠 workspace 绑定（一次性设置，之后全自动）：

- 指向已有本地 repo → 走 trust 确认，绑定/创建该 workspace；
- 给 git URL → 自动 clone 到托管目录 `~/.superclaw/companies/<公司>/<repo>/`（managed，trust 天然 ACTIVE）；
- 之后 issue 的 assign → checkout（既有 workspace lock）→ run 全自动落在公司 workspace，零手动。

Paperclip 的 ExecutionWorkspace 实例层（每次执行独立 worktree/沙箱副本）**明确不做**，留给未来 delivery 公司需求；加的时候不动现有概念。

## 8. 落地顺序

1. 本 ADR（独立 docs commit）。
2. 内核地基：repo-identity resolver + 危险目录黑名单 + schema 迁移（chat_sessions.workspace_id 列、WorkspaceProfile trust 字段）。
2b. 关闭 `_assert_governance_scope` 的 free-form 旁路（独立原子提交，涉及 team kernel 流程与测试面；**在它关闭前不得宣称内核 fail-closed 完成，也不得接 CLI/API/Web 表层**）。
3. CLI：trust-create 交互、`chat --workspace`、`--continue` workspace 过滤、`workspace sessions/adopt`。
4. API filter + `ui_contracts.py` workspace 投影（与 CLI 共用同一内核 resolver，零偏差）。
5. Web：侧栏按 workspace 分组 + Chat 区 + Trust Barrier。
6. 公司向导自动绑定/物化 workspace。
7. 并行轨：纯 chat run_id 缺口（unified-task-entry P1）；workspace 成本视图严格 gate 在其后。

---

## 演进：个人项目目录可见化（real_folder_v1，2026-06-21）

L34/L51 的 `kind=managed`「app 自有目录、构造信任 ACTIVE」适用于**我们原子新建、无既有用户数据**的目录。据此，个人「新建项目」的 managed 目录从隐藏 `~/.superclaw/workspaces/<id>` 演进为**可见的 `~/SuperClaw/<slug>`**（仿 L44 Codex 文件夹结构），保持 MANAGED/构造信任/`writable_paths=["."]` 不变，仅位置可见化。安全由 fd-relative `O_NOFOLLOW` 原子创建 + inode pin + 执行前复核（fail-closed）保证；任何**已存在**目录（含空目录）一律走 attach 人审（防预建目录绕审，守 L60）。详见 sidebar-rework-roadmap §9。
