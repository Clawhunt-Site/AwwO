# Node 引擎 agent ↔ 能力(plugin / skill)桥接 —— 实现设计

> **状态:落地规格(implementation spec)。承接并具化 [[plugin-agent-mcp-bridge-design]]
> 的方案裁定(同日 Codex gpt-5.5 + agy Gemini 3.1 Pro 双路对抗式评审的强共识),
> 以及 [[chat-plugin-tools-not-wired-server-refactor]] 的缺口诊断。基于
> `dev/server-refactor` @ `6907dc0f` 真实代码核验。**
>
> 日期:2026-06-30 ·  分支:`feat/node-agent-capability-bridge`

## 0. 一句话

让 **Node Paperclip 引擎**上跑的 agent(任意 company,含 chat 这个本地 company)
能**真正发现并调用**已安装 plugin 的工具,机制是 **host 自有的 per-run MCP 桥**
(runContext 由 host 绑定、MCP 工具参数只放业务参数、统一走治理 router)。
**skill 链路已通,本设计补 plugin 这条断链**;chat 因为就是一个 company,补好 company
即自动覆盖 chat。

## 1. 现状诊断(代码实证,file:line)

### 1.1 chat == company(同一抽象,同一物化链路)
chat 是固定 ID 的本地 company `LOCAL_CHAT_COMPANY_ID`(`chat-compat.ts:119`,
`ensureLocalChatCompany()` `:198` 懒创建),与真实 agent-company **共用**
`heartbeatService.wakeup()`。**company 能用的 chat 就能用,反之亦然。**

### 1.2 SKILL —— 已端到端打通 ✅(只需回归保护,不在修复范围)
`heartbeat.ts:9008` 解析 `@skill` → `:9050` 并进 `desiredSkills` →
`company-skills.ts:4155` 枚举 → `global-runtime-skills.ts:424` 并入全局
(digest 字节一致 `:196` + revocations `:220` 双 fail-closed)→ `heartbeat.ts:9065`
注入 `runtimeConfig.paperclipRuntimeSkills` → `:9786` `adapter.execute` →
claude-local `--add-dir` 物化进工作区。chat 与 company 走同一条,无差异。
> ⚠️ 落地需补一项核验:**确认每个 chat-eligible adapter(claude/codex/gemini/…)
> 都真的物化 `paperclipRuntimeSkills`**(claude 用 `--add-dir` 已确认;其余 adapter
> 是否等价物化需逐一核,避免"配置里有、agent 看不到"的隐性偏差)。

### 1.3 PLUGIN —— 对**所有** agent(含 company)都断链 ❌
三断点(grep 实证,@6907dc0f 仍成立):
| # | 断点 | file:line |
|---|---|---|
| ① run 路径不装配 plugin 工具 | `heartbeat.ts:9065`(只有 `paperclipRuntimeSkills`) |
| ② adapter 接口无工具派发 | `adapter-utils/src/types.ts`(`ServerAdapterModule`/`AdapterExecutionContext` 零 `toolDispatcher`) |
| ③ agent 不连任何 MCP | `claude-config.ts:45` `delete settings.mcpServers`;`buildClaudeArgs` 无 `--mcp-config` |

`executeTool` 全树只被 HTTP 路由调用(`plugins.ts:1015`、`super-workshop.ts:271`)。
老 Python 内核有完整 `plugin_mcp_proxy` 聚合投影(`docs/plugin-runtime-projection.md`),
**未移植到 Node**——故 Node 上 company 也用不了 plugin,不是 chat 独有缺口。

### 1.4 关键纠正:HTTP `/tools/execute` **不是**现成的治理桥(别误用)
两个曾被高估、经复核证伪的点:
1. **它绕过 super 验签门。** `/api/plugins/tools/execute`(`plugins.ts:1015`)走的是
   `toolDispatcher.executeTool → registry.executeTool`(`plugin-tool-dispatcher.ts:402`),
   **不**经 `plugin-runtime-router.executeTool`(`plugin-runtime-router.ts:131`)——
   而后者才有 **super provenance + digest 漂移 + 双 store 冲突拒绝**。桥必须改走 runtime-router。
2. **它的鉴权在 local-trusted 会落成 board actor。** `assertBoardOrAgent`(`:967`)
   在本地可信、无 token 时落成 board actor;`validateToolRunContextScope`(`:753`)只证
   runContext 四件套**DB 自洽 + company 可访问**,**不证调用者身份**——同 company 内可冒用他人
   `agentId/runId`。而 `req.actor.runId`(`:740`)已可用,host 本可绑定身份。

### 1.5 其它已核验缺口
- 发现面非 run-scoped:`listToolsForAgent`(`plugin-tool-dispatcher.ts:394`)/`GET /tools`
  (`plugins.ts:940`)是 registry 全量,无 per-agent/project/operator 限制。
- 参数 schema 未服务端强制:registry 存 `parametersSchema` 但 raw 参数直丢 worker。
- agent env 缺 run 上下文:`buildPaperclipEnv`(`server-utils.ts:1208`)只设
  `PAPERCLIP_AGENT_ID`+`PAPERCLIP_COMPANY_ID`,无 `RUN_ID/PROJECT_ID`。

## 2. 方案裁定(已经 Codex+agy 双路对抗验收,强共识)

**采纳:host 自有 per-run MCP 桥。** 桥必须 **per-run + server-bound**:每个 run 由 host
生成一组 MCP 工具,runContext 由 **host 绑定**,MCP 工具参数**只放业务参数**,
**绝不**让模型传 `agentId/runId/companyId/projectId`。

**否决的三条(及致命缺陷):**
- **裸接 HTTP execute 给 CLI agent**(≈ 教 agent curl `/tools/execute`):绕 super 验签
  (§1.4-1)、鉴权可落 board(§1.4-2)、无服务端 schema 强制、审计/事件断 → **否**。
- **stdout 拦截**(解析 agent 输出里的 tool-call 转调):缺 schema、缺发现、脆弱 → **否**。
- **prompt 教 agent curl**:无 schema、绕鉴权审计、模型自报 runContext → **否**。

> 这是已定结论,本文档**不重新审议路线**,只规格化落地。

## 3. 八条阻断前置(必须先解决,fail-closed)

1. **鉴权击穿**:`plugins.ts:966` 的 `assertBoardOrAgent` 在 local-trusted 无 token 落成
   board actor;runContext 只证自洽不证身份 → host 发**单-run 绑定、用后即焚的短票据 /
   agent JWT**,执行端验票 + actor 一致,**拒隐式 board**。
2. **工具清单非 run-scoped**:`listToolsForAgent`/`GET /tools` 是 registry 全量 → 按
   per-agent/project/operator 限制收窄发现面。
3. **super provenance 被绕过**:桥**必须**改走 `plugin-runtime-router.executeTool:131`
   (super 验签 + 双 store 冲突拒绝),不走 registry 直执。
4. **参数 schema 非服务端强制**:执行端**服务端校验**参数后再入 worker;MCP schema 只帮模型、不能替代。
   ⚠️ **schema 来源按 runtime 区分**(实现期发现,勿用单一来源):super 工具**不在**内存 tool registry 里
   (registry 只装 paperclip JS 工具),其声明/schema 在 super runtime record 的 `tools[].inputSchema`
   (`super-plugin-runtime-store.ts` / `super-plugin-manifest.ts:41`);paperclip 工具在
   `registry.getToolByPlugin().parametersSchema`。故校验须**就地按 runtime 取 schema**,且**不得**用
   `registry.getTool` 当存在性门(会把 super 工具误判为"不存在"挡掉)——存在性交给 runtime-router 跨双 store 解析。
5. **remote 必须默认禁用**:`claude-config.ts:45` 删 mcpServers 是安全门;反向开桥=把
   本地内网/FS 暴露给云端沙盒。**MVP 仅本地注入,remote 不注入。**
6. **`@paperclipai/mcp-server` 不是答案**:它暴露 Paperclip API escape hatch,非 plugin
   execute 桥;不要复用它当 plugin 桥。
7. **run log / Web 事件会断**:chat 消费 `heartbeat.run.log` stdout,host 内调工具不冒
   `tool.started/completed`;`chat-display-projector` 只把 `mcp__*` 判 MCP → 桥要主动
   写 run log + 投递 tool 事件。
8. **codex 全局 config 污染**:`codex-home.ts` 拷共享 config 会继承 `mcp_servers` 致信任
   漂移 → **per-run overlay 清理**。

## 4. 目标架构与数据流

```text
heartbeat.wakeup (per run)
  └─ 决策:本 run 是否挂 plugin 工具(policy / opt-in，见 §8)
        └─ plugin-agent-mcp-bridge.ts（新建，host 自有，per-run）
             · 按 run 解析「可用 plugin 工具」(run-scoped + entitlement 过滤)  [阻断 2]
             · 生成本 run 专属 MCP 工具定义（业务参数 schema only）
             · host 绑定 runContext + 签发单-run 短票据                       [阻断 1]
        └─ adapter 注入（仅本地）                                            [阻断 5]
             · claude: 写专门 --mcp-config <file>（裁决：不用 extraArgs）
             · codex : -c mcp_servers.… + per-run overlay 清理               [阻断 8]
        └─ agent 调 MCP 工具（只传业务参数）
             └─ 桥进程 call → 服务端 schema 校验                              [阻断 4]
                  └─ plugin-runtime-router.executeTool:131                    [阻断 3]
                       · super: 验签 + digest + 双 store 冲突拒绝
                       · paperclip_js: 原生 dispatcher
                  └─ 写 run log + 投递 tool.started/completed 事件            [阻断 7]
```

### 4.1 桥的进程边界 —— 【已修订:改采形态 A】

> **修订(slice 3 实现期,基于实现期发现的事实 + agy 复评强背书;Codex 复评待其配额恢复补齐)。**
> 原裁定为形态 B(host 进程内 loopback HTTP/SSE);现**改采形态 A(stdio MCP 桥 bin,复用现有 agent→host 通道)**。

CLI 连 MCP 有两种载体:stdio(spawn 一个命令)或 loopback HTTP/SSE(连一个本地 URL)。
**裁定:采用「stdio MCP 桥 bin(无状态代理),复用现有 run-JWT + agent→host HTTP 通道」(形态 A)。**

**翻转依据**——§4.1 原否决形态 A 的三条理由,在以下实现期发现的事实面前**已被消解**:
1. 单-run 不可伪造票据**已存在**:`agent-auth-jwt.ts` 的 `createLocalAgentJwt`(短 TTL、绑 run_id、per-company HMAC),
   `heartbeat.ts:69` 已 per-run 签发;auth 中间件已解析成 `req.actor`。
2. agent→host 带签名回调通道**已存在**:`buildPaperclipEnv`(server-utils.ts)已把 `SUPERCLAW_API_URL/API_KEY(=run-JWT)/RUN_ID`
   + AGENT_ID/COMPANY_ID 注入 agent 子进程 env。故「token 进子进程 env」是**现状沉没事实**,桥只是读取消费,不新增暴露面。
3. REST `/tools/execute` 已被 slice 1+2 **完整治理**(runtime-router 验签 + 服务端 schema 强制 + agent 身份绑定),
   不再是「裸管理面」——「多一跳」就是 agent 现有的 loopback HTTP 通道,延迟相对 LLM 推理可忽略。
   形态 B 为「不走 REST」要净建 SSE/StreamableHTTP transport + 长连接/会话状态/并发上下文管理,是捡芝麻丢西瓜。

**形态 A 落地**:新建 stdio MCP 桥 bin(复用官方 `@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`,
照搬 `@paperclipai/mcp-server` 模式);从 env 读 `*_API_URL/API_KEY/RUN_ID/AGENT_ID/COMPANY_ID`;
`tools/list` → `GET /api/plugins/tools`;`tools/call` → `POST /api/plugins/tools/execute`。
**runContext 由桥从 env 组装,且 `projectId` 由 host 端从 runId 派生(绝不信客户端);桥 bin 不接受模型/客户端传入 agentId/runId(全从 env/JWT 闭环)。**
claude `--mcp-config` spawn 它;codex `[mcp_servers]` per-run overlay 同(阻断 8)。

**形态 A 的工程阻断点(agy 复评指出,实现必须覆盖)**:
- **取消传递**:桥须监听 MCP cancel → 转 HTTP `AbortController` 打断发往 host 的 `/tools/execute`,防失控工具在 host 端裸奔。
- **大载荷背压**:HTTP 响应转 stdio 时稳健处理 Node stdio buffer,避免 JSONRPC 帧截断解析崩溃。
- **env 卫生**:桥 bin 持有 run-JWT,绝不拉起不受信子进程;若 spawn 须显式清洗敏感 env。

## 5. file:line 落点(六处,行号以实现时复核为准)

1. **新建** `server/server/src/services/plugin-agent-mcp-bridge.ts`:按 run 生成 MCP 工具
   + 绑 runContext + 服务端校 schema + 走 runtime-router + 写 run log/events。
2. **鉴权收紧** `routes/plugins.ts:966`(execute)+ 发现面收窄 `:940` / `plugin-tool-dispatcher.ts:394`。
3. **统一双 runtime** 经 `plugin-runtime-router.ts:131`(桥执行端改走它)。
4. **Claude 注入** `claude-local/.../execute.ts:712`(`buildClaudeArgs`)用专门
   `--mcp-config <file>`(**裁决:不用 extraArgs**)+ `claude-config.ts:45` 仅本地放行 super 注入。
5. **Codex 注入** `codex-local/.../execute.ts`(≈`:796`)+ `codex-home.ts`(≈`:8`)per-run overlay。
6. **事件投影** `routes/chat.ts`(≈`:674`)+ `chat-display-projector.ts`(≈`:43`)识别桥工具事件。

## 6. 不变量(治理红线)

1. plugin 执行治理全在 server 端、统一经 `plugin-runtime-router.executeTool:131`;
   桥只做"发现 + 绑定 + 转发 + 校验",绝不重写执行或绕治理(CLI 唯一事实源 + 表层零新增语义)。
2. runContext **host 绑定**,模型不得自报;单-run 短票据,执行端验票 + actor 一致。
3. fail-closed:未安装 / 签名无效 / digest 漂移 / 被吊销 / 无 entitlement / 未声明工具 /
   schema 不符 → 拒。
4. 危险能力(`http.outbound` / 扫描 / 支付 / 人审)**投影前过滤**,不等 worker 拒;高危不以裸原生工具暴露。
5. company 与 chat 零偏差:同一 company 抽象 + 同一桥;不为 chat 写并行实现。
6. remote MVP 不注入(阻断 5);桥按 `server/doc/plugins/PLUGIN_SPEC.md` 收敛,保持可上游化。
7. **token 静止保护**(防同机进程窃取):单-run token 仅写进 mcp-config 文件,**文件权限 `0600`**;
   **不进 argv**(避免 `ps`/`/proc/<pid>/cmdline` 泄露);loopback 端点**仅绑 `127.0.0.1`**;
   token 短 TTL + 单 run 绑定 + **run 结束即吊销**;子进程 env 不透传 token。
8. **输出经治理后才回模型**:工具结果在桥内统一过 **secret redaction + 字节预算**(移植 Python
   `redact_secrets` + output budget 语义),再投给 MCP `tools/call` 响应;错误统一 envelope + 错误码。

## 7. 落地排序(原子提交)+ 测试矩阵

| 阶段 | 内容 | 主要落点 | 测试(金字塔:断言进程内,真子进程/签名归集成串行) |
|---|---|---|---|
| **P0** | 执行端治理地基:桥执行改走 runtime-router(阻断 3)+ 服务端 schema 强制(阻断 4)+ 单-run 票据鉴权(阻断 1) | 落点 1/2/3 | 单测:绕 router 的 super 调用被拒;schema 不符拒;伪造/board 落空 → 拒 |
| **P1** | per-run 桥生成 + 发现面 run-scoped/entitlement 过滤(阻断 2)+ run log/事件(阻断 7) | 落点 1/6 | 单测:跨 company/无授权工具不出现;tool.started/completed 投递 |
| **P2** | Claude 本地注入 `--mcp-config`(阻断 5 仅本地)+ opt-in policy(§8) | 落点 4 | 集成:真 claude 端到端 list→call→治理门 |
| **P3** | Codex 注入 + codex-home per-run overlay(阻断 8) | 落点 5 | 集成:codex 端到端 + config 不污染 |
| **P4** | skill 物化对齐回归(§1.2 核验)+ 文档 + 体验打磨 | — | 全量门 + skill 不回归 |

> P0 先行:**治理优先于体验**——执行端身份/验签/schema 是地基,先于任何注入。

### 7.1 完整性项(非阻断,但实现时必须收口,勿漏)
随各阶段一并落,且配测试:
- **超时 / 取消统一**:native worker 执行路径当前无显式 per-call 超时,super 路由有 60s。
  桥侧统一 per-call 死线 + 取消 + worker-died 错误码(归集成串行家族,死线可注入/放宽,见 §10)。
- **输出 redaction + 字节预算**(对应 §6 不变量 8):移植 Python `redact_secrets` + output budget;
  单测断言 secret 不外泄、超预算截断。
- **MCP 工具名稳定编解码**:命名空间形式 `plugin:tool` 含 `:`,MCP 工具名可能不容 →
  需稳定 encode(注入时)/decode(`tools/call` 路由回 pluginKey+toolName)双向无损;UI 仍显原始 namespaced 名。
- **skill 各 adapter 物化一致性**(承 §1.2 ⚠️):逐一核 chat-eligible adapter 是否等价物化
  `paperclipRuntimeSkills`,补回归,杜绝"配置有、agent 看不到"的隐性偏差。

## 7.2 ⚠️ 接桥前必做的安全门(blocker before slice 3b wiring)

slice 3a 把 `/api/plugins/tools/execute` 的 projectId 绑定到「拥有该 run 的 issue」(`issues.checkoutRunId/executionRunId → projectId`,host 写、agent payload 不可直接改),并要求 distinct 恰好一个项目、fail-closed,且 execute 面只认签名 run-bound agent JWT(拒 agent_key)。**但 Codex 对抗式审查指出一个预存的、更深的信任链弱点(#1,非本桥引入,影响整个 issue/run 授权)**:agent 自唤醒(`agents.ts` invoke)的 `payload.issueId` 会进 `heartbeatRuns.contextSnapshot.issueId`,claim 时(`heartbeat.ts:7575`)据此把 `executionRunId` 写到该 issue;而 interaction-wake 授权(`allowsIssueInteractionWake`,只看 wakeReason+commentId)弱于完整的 `isVerifiedIssueTreeControlInteractionWake`(source/actor/comment 校验)。即:issue-run link 的**生成侧**仍可被 self-wake 间接塑形,故 run→project 派生的可信根尚未完全立住。

**裁定(业主 2026-06-30)**:slice 3a 在每一层都 strictly 比合入前(仅 company-scope、无 run 绑定)更安全,先落地;**#1 作为独立的核心 heartbeat 自唤醒/claim 授权硬化 slice,必须在 wiring 桥(slice 3b,把 `--mcp-config`/codex overlay 接给 adapter、让 agent 真正能调)之前关闭**。在 #1 关闭前**不得 wiring 桥**——否则等于把一个 self-wake 可塑形的 run→project 绑定暴露成 agent 可达的执行面。#1 的修法:把 `allowsIssueInteractionWake` 升级为 `isVerifiedIssueTreeControlInteractionWake` 等价校验,或在 claim 写 issue-run link 时拒绝/忽略 agent 提供的 privilege-bearing `payload.issueId` 除非已验证该 issue 属当前 agent 可操作范围。

## 8. 已共识的开放项(待业主拍板细节)

- **chat 默认不挂 plugin 工具**(opt-in / policy):避免每个 chat 都注入 + 上下文成本;
  显式 `@plugin:xxx` 或开关启用。**默认范围需业主定**(全默认挂 vs 默认空+点名)。
- **危险能力投影前过滤**:`http.outbound` / 扫描 / 支付 / 人审类在生成工具清单时即排除或标人审。
- **CLI 零偏差**:superclaw CLI 走同一 Node heartbeat + 同一桥;Python
  `_project_plugins_into_policy` **不得**成第二套投影(能力先进内核)。
- **remote MVP 不支持**(阻断 5)。
- **是否并入 `feat/chat-capability-manager`**:该分支已建 `plugin-manager`(管理面)seed skill
  未并主干;本设计是"使用面"补全,落地时宜一并处理,避免管理/使用两套 seed 漂移。

## 9. chat 如何自动获益
桥按 company/run 注入,auto-policy 覆盖所有 company → `LOCAL_CHAT_COMPANY_ID` 天然命中
(受 §8 的 chat opt-in 约束);因 chat==company(§1.1),零偏差覆盖,无需 chat 专属分支。

## 10. 验收门
- 每阶段测试齐全(进程内伪造执行边界,真子进程/签名归集成串行家族);
- 推 PR 前本地全量 `scripts/run-ci-tests.sh` 跑通(远端 CI 暂停期);
- 提交前**双路对抗式验收**:项目铁律要求 **Codex(gpt-5.5)+ Gemini** 两路独立批判,均无阻断才过。
  注意 agy(Antigravity)与 `gemini-cli-advisor` 是**不同顾问**——本线若以 agy 充第二路或业主明确豁免第二路,
  须在提交说明里**留痕**(谁、何时、为何豁免),不得默认 Codex 单门;
- 原子提交:P0–P4 各自独立 commit。

## 11. 关键文件 / 记忆索引
- 缺口诊断:[[chat-plugin-tools-not-wired-server-refactor]]
- 方案裁定(8 条阻断 + file:line 来源):[[plugin-agent-mcp-bridge-design]]
- 入口/物化:`heartbeat.ts`(`:9050`/`:9065`/`:9786`)、`chat-compat.ts:119`/`:198`
- 治理:`plugins.ts`(`:940`/`:966`/`:753`)、`plugin-runtime-router.ts:131`、`plugin-tool-dispatcher.ts:394`
- adapter/env:`adapter-utils/src/types.ts`、`server-utils.ts:1208`、`claude-config.ts:45`、
  `claude-local/execute.ts:712`、`codex-local/execute.ts`、`codex-home.ts`
- 事件:`routes/chat.ts`、`chat-display-projector.ts`
- Python 蓝本/上游契约:`docs/plugin-runtime-projection.md`、`docs/unified-capability-layer-design.md`、
  `server/doc/plugins/PLUGIN_SPEC.md`
