# Paperclip 移植设计符合性审计（main 实测，2026-06-20）

> 基准 = `agent-team-kernel-execution-plan.md`（P0 三柱 + A2A 闭环 + §2.7 + P1 四切）/ Paperclip §7 任务清单。
> 方法 = 对团队 `main`（审计时 6c93622 / origin 204089f）逐项**实测代码**（非凭审计 agent 表面判断）。
> 结论一句话：**main 比快速审计看到的成熟得多**——大量"缺口"实为已处理；本文纠正假缺口、钉清真剩活，供各会话/域 owner 取用，避免重复追假缺口或重复实现造冲突。

## A. 已扎实落地（实测 verbatim 确认）

| 支柱 | 证据（符号/文件） |
|---|---|
| **P0 柱3 cost_events 账本** | 独立 append-only 表 + `record_cost_event`(idempotency_key INSERT OR IGNORE) + `summarize_cost`(by scope) + usage 缺失 fail-open 落 `unavailable`/`not_applicable`；orchestrator 单一 recorder 不重复计数 |
| **P0 柱2 治理命名空间** | `CompanyProfile`+`WorkspaceProfile`(repo_path/writable_paths/network_policy/default_permission_policy) 替 hardcoded local；缺 company/workspace fail-closed |
| **P0 柱1 charter 进运行时** | `AgentProfile.charter/persona/charter_source/charter_revision_id` → `build_agent_run_context`(charter+granted+manager_chain) → `agent_prompt.build_agent_prompt_envelope` 六层信封 → backend `_prompt` 真注入 |
| **A2A 委派** | marker 触发 → `parse_delegation_request` → `authorize_delegation_for_parent` 10 步 fail-closed 准入；charter 消费；以 B 身份执行(child agent_profile_id/depth/principal)；unknown profile fail-closed |
| **chat 成本接入** | 纯/direct/streaming chat 有 run_id + 幂等 CostEvent，按 company/workspace scoped；CLI `cost list/summary` + API `/api/cost/*` |
| **Bootstrap** | template→side-effect-free proposal(granted/dropped/pending+budget min 只降+charter lint+reports_to 无环) → atomic commit(高危落 pending approval 经 resume) + 不可变审计 |
| **结果回流压缩 + manager loop** | `{status,summary,output tail}` 不塞原文；daemon `_rework_brief` 注入 child_done；depth cap |
| **issue 事件流** | `IssueComment` + `IssueThreadInteraction`(continuation_policy: wake_assignee/notify_parent/escalate_to_board) first-class |
| **charter 授权边界 lint** | 禁 bypass/auto-pay/扩工具 |
| **budget 门** | issue checkout preflight 硬门(409) + 软告警 burn-down |
| **前端 + 铁律** | BootstrapWizard/OrgChart/AgentDetail/CostOverview/ApprovalPayload 接线；mutation 走 API；ui_contracts 集中；不乐观授权；CLI↔API 共享内核零偏差 |
| **T11 低信任围栏** | ContainmentPolicy + `_resolve_run_containment` 单一 choke point + backend `supports_containment` 契约(codex/claude 真机 canary 证明 read-only 不拦读→拒跑，B 类 in-process regex read gate 唯一可证 realizer) |

## B. ⚠️ 实测为「假缺口」（已处理，勿重复实现，重复会冲突）

| 审计曾报 | 实测结论 |
|---|---|
| **max_concurrency=1 兄弟委派门 缺失** | **已处理**：`checkout_issue` 取 `workspace_lock_key`——serial 工作区一把锁→兄弟天然串行(锁排队/失败,绝不双写)；per_issue 是故意允许并行。审计漏看 checkout 的 workspace 锁。 |
| **高危 escalate 自动触发 缺触发点** | **已处理**：`team_kernel.py:1095` 子完成时给父挂 COMPLETION 续约——父有 assignee→`NOTIFY_PARENT`(daemon 处理)/无→`ESCALATE_TO_BOARD`。 |
| **issue 事件流 缺失** | **已处理**：`IssueComment`+`IssueThreadInteraction` 已是 first-class 数据模型。 |

教训：审计 agent（Explore 快速过）系统性高估缺口；**动手前必逐项实测代码**，不修已有覆盖的非缺口。

## C. 真·剩余缺口（已铺路径，勿盲目动手）

| 缺口 | 状态 / 路径 |
|---|---|
| **装备 granted-only 投影未在执行层强制**（§2.6 item4「最大治理漏洞」） | 第 1 层(投影收窄+fail-closed)已做 → **Draft PR #279** + `docs/a2a-equipment-projection-handoff.md` + spawn task。真边界 = **proxy 按 per-agent grant 强制**(plugin_mcp_proxy 域) + **cross-runtime 接线**(PR #237 域)。**勿当已闭合**。 |
| **typed issue `kind`/`review_policy` + QA 打回回环** | 高价值但**必须改 `models.py`**（与 company-export 会话碰撞点）→ 需先敲定 models.py 改动区再做。 |
| **委派 context_pointers 穿透** | 需 models.py（同上协调）。 |

## D. 并行协作约束（本轮踩坑留痕）
- 团队 main 高频被并行会话推进（本会话经 5+ 次 main 漂移）；本地工作易脱离主线——**做完先查"是否已在 origin/main"**（本会话 T0/T1/T11/T12 即已 verbatim 进 main，险些重复抢救）。
- `models.py` 是 company-export 会话与内核底座工作的唯一碰撞点：动某 dataclass 前先协调改动区。
- 遵守 `coordination.md`：main 只读镜像、worker 分支各自 worktree→dev/roadmap 验证→worker 分支开 PR。
