# 架构不变量治理路线图（Test-as-Policy）· 框架参考 / 未开发

> ⚠️ **本文仅为开发框架参考（design reference），不是已承诺的开发计划，也尚未实现。** 这套机制未开发、未验证，**不可用于生产**；是否采纳、何时开发均待定。在它真正落地（`tests/arch/` + pre-commit 能跑红）之前，它**不构成任何实际约束**，只作为后续开发时的思路参照。
> **目的**：为并行开发的真实痛点——功能 B 继承/共用功能 A 的架构时发生漂移——提供一个**思路框架**。约束的牙齿应放在**可执行的架构测试**，而非散文文档。
> **状态**：📝 框架参考 / 设计构想——未开发、未验证、非承诺项（现状零 arch 测试）。
> **评审留痕**：经两轮 Codex(gpt-5.5) + Gemini 对抗式评审 + 主代理综合裁决（简报 `/tmp/roadmap-governance-briefing.md`、`/tmp/roadmap-invariants-design.md`，transcript 落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`）。
> 关联：`CLAUDE.md` 铁律（全局不变量源）、`ui_contracts.py`（首个契约事实源）、`workspace-trust-container.md`(ADR 先例)。

---

## 0. 决策（ADR 式）

**选定：Test-as-Policy。** 每条架构不变量 = 一个可执行测试，函数名即规范；接 pre-commit + CI；测试树本身就是不变量索引。

**否决（三方一致）：**
- ❌ 4-文件平行治理体系（VISION/ROADMAP/ARCHITECTURE/AI_RULES）——新增需彼此同步的真相点，违反铁律#1（CLI/契约唯一事实源），Token 黑洞。
- ❌ 在 markdown 里造 INV-ID 编号 + "承自"外键 + 给 N 份文档各加 Invariants 节——"用格式化文本约定解决代码架构漂移的物理问题=用交规手册防车祸而非装隔离墩"；LLM 多文件跳转 >3 跳即幻觉，会编造不存在的 ID 交差。

**一句话**：能约束住"B 继承 A 却漂移"的不是文档、也不是"另一个 LLM 读文档"，而是 **CI 里的架构测试**（fail-closed，话术绕不过）。

## 1. 真问题与分工

| 漂移类型 | 例子 | 强制手段 |
|---|---|---|
| **结构性** | B import A 的内部 / 绕过内核 API / 前端硬编码本属 `ui_contracts.py` 的列表 | **架构测试**（AST / import-linter，机器抓） |
| **语义性** | B 悄改 A 契约的*含义* / 削弱某 fail-closed 门 / 重释"充分显示" | **双顾问 commit 门 + checklist**（AST 看不出，需判断） |

纯机器测试欠语义层，纯人审欠结构层——真相是这个 split，两侧共读同一棵 `tests/arch/` 树。

## 2. 三层强制（每层只管它真能管的）

1. **机器闸门（唯一有牙齿）** — `tests/arch/`：每条结构不变量一个测试，函数名即规范（`test_surface_layer_must_not_import_runtime_models()`）；接 pre-commit + CI。**设计阶段的不变量 = `@pytest.mark.skip(reason="设计阶段：<一句话约束>")` 占位测试**——诚实表达"尚无牙齿"，且谁实现该子系统谁在同一 PR 里 un-skip。
2. **语义闸门** — 已有双顾问门加一节：「本改动是否削弱/绕过所触及子系统的任何架构不变量？逐条 pass/fail」。待查清单**从 `tests/arch/` 的测试名 + skip reason 派生**，不另建文档。
3. **触发识别** — 一个小脚本从 diff 的**文件路径机械派生**该跑哪些 arch 测试、喂哪份 checklist 给顾问；**不靠 AI 自报**（否则填 None 糊弄）。

## 3. 两条硬规则（应同步进 `CLAUDE.md` 才有全局牙齿）

1. **改一条不变量 = 必须在同一个 commit 里改/un-skip 它对应的测试。** 这就是"设想被明确优化"的精确工程形态：在你改测试之前，CI 红灯物理性挡住漂移。
2. **CI/commit 门 > roadmap 准入；"准入通过 ≠ 架构通过"。** 防止用"路线图说可做"反驳"架构检查说违规"，避免两门打架与责任稀释。

## 4. 诚实的近期边界

现状 80% 子系统是 📝/🔧 未建，其不变量只能是 `[设计阶段]` 占位测试 → **近期这套只对少数已建子系统有真牙齿**（`ui_contracts` 一致性、fail-closed 支付门、铁律#4 表层零业务语义）。不 oversell；"弱"被诚实表示为测试树里一排 skipped 测试，而非假装生效的 markdown。

## 5. 第一周启动序列（只做一件，证明有牙齿）

1. 新建 `tests/arch/test_ui_contracts_drift.py`：用 `ast`/反射断言 Web/Desktop 表层字段声明严格等于 `ui_contracts.py`。
2. 接 pre-commit + CI。
3. **故意提一个在表层私自加字段的 PR，看 CI 把它干掉、双顾问只能对着红灯认怂**——这就是"约束有牙齿"的样子。全程不碰 markdown。

## 6. 现状基建（已代码核实）

- 契约事实源：**仅 `ui_contracts.py`**；`display_contracts.py` / `prompt_contracts.py` 仅规划。
- **零架构/契约/边界测试，无 import-linter，无 pre-commit。** 机器闸门是从零起步。
- 子系统文档（`agent-runtime-display-protocol.md`、`cross-runtime-delegation.md`）已用"原则 + 护栏 + 指向 contracts 事实源"的家规——是收割不变量的来源，但**不在其中编 ID**。
