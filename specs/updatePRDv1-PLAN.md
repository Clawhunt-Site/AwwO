# updatePRD v1 — PLAN（开发计划）

> 对应需求：`specs/updatePRDv1.md`
> 日期：2026-06-28 | 负责人：LK
> 总目标：**SuperClaw 网页版独立跑通 → 双服务端 chat 端到端 → 嵌入 ClawHunt 联调**

---

## 执行说明

- 每个任务**独立可执行**、控制在 2 小时内、完成即可提交。
- 任务按依赖顺序排列；**到「验收检查点」时停下来**，汇报后等用户说"继续"再往下。
- 状态标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[!]` 需修改。
- 提示词以**角色定义**开头，可直接喂给 AI 执行。

---

## 阶段 0：Docker 基线验证（main 分支，纯 Python）

> 先拿到一个「能跑的东西」，验证核心引擎在 Linux 容器里活着、前端能打开。Windows 崩溃问题被容器规避。

### [x] Task 0.1 — 创建 .dockerignore 优化构建上下文

**背景**：当前仓库**没有 `.dockerignore`**，`docker build` 会把 `.git`（448+ PR 历史，巨大）、`node_modules`、`.superclaw` 运行态、`third_party` 等全部塞进构建上下文，拖慢甚至撑爆构建。

**AI 提示词**：
```
你是一位资深 Docker 工程师，精通构建上下文优化。请在 SuperClaw 仓库根目录创建 .dockerignore 文件。

要求：
1. 排除版本控制与 IDE：.git、.gitignore、.vscode、.idea
2. 排除依赖与构建产物：**/node_modules、**/dist、**/target、**/__pycache__、**/*.pyc、.venv、venv
3. 排除运行态与本地状态：.superclaw、data、**/*.db、**/*.db-wal、**/*.db-shm
4. 排除文档与无关目录：docs、specs、CCimages、third_party（Dockerfile 不需要它们）
5. 排除测试与缓存：.pytest_cache、.ruff_cache、.codex-cli-advisor、.gemini-cli-advisor
6. 注意：Dockerfile 只 COPY 了 pyproject.toml、README.md、packages、apps，所以可以放心排除其他顶层目录
7. 文件内每条加简短中文注释说明排除原因

参考 Dockerfile（main 分支）只 COPY：pyproject.toml README.md packages apps，构建分两阶段（node:22-slim 构建 web → python:3.12-slim 跑 uvicorn）。
```

**验收**：`.dockerignore` 创建完成，包含上述排除项。

---

### [x] Task 0.2 — 构建 Docker 镜像并排错

**AI 提示词**：
```
你是一位资深 Docker 工程师，精通多阶段构建排错。请在 SuperClaw 仓库根目录构建主服务镜像，并解决构建中出现的任何问题。

执行：
1. cd 到仓库根目录
2. 运行：docker compose --profile superclaw build
3. 观察构建日志，重点关注：
   - web 阶段：npm ci --prefix apps/web 是否成功（Vite 8 + React 19，node:22-slim）
   - web 阶段：npm run build --prefix apps/web 是否产出 dist
   - python 阶段：pip install -e . 是否成功（pyproject.toml 依赖）
4. 若构建失败，定位根因并修复（不要绕过、不要降级依赖除非必要），修复后重新构建
5. 构建成功后，运行 docker images 确认镜像存在

注意：开发机是 Windows + Docker Desktop，构建在 Linux 容器内进行。报告构建耗时与镜像大小。
```

**验收**：`docker compose --profile superclaw build` 成功，`docker images` 能看到镜像。

---

### [x] Task 0.3 — 启动容器并探活 API

**AI 提示词**：
```
你是一位资深后端运维工程师。请启动 SuperClaw 主服务容器并验证 API 健康。

执行：
1. 后台启动：docker compose --profile superclaw up -d
2. 确认容器状态：docker compose ps（应为 running / healthy）
3. 探活：curl http://localhost:8080/health
   - 期望返回：{"ok":true,"service":"superclaw"}
4. 若容器启动失败或探活失败：
   - 看日志：docker compose logs superclaw-api
   - 定位是端口冲突、依赖缺失、还是启动崩溃（注意 Python 内核的 Windows 崩溃点不应在 Linux 容器里出现）
   - 修复后重启验证
5. 报告：容器状态、健康检查结果、启动日志中的告警

注意：apps/api/main.py:3519 定义了 /health 端点。容器监听 8080 端口。
```

**验收**：容器 running，`curl http://localhost:8080/health` 返回 `{"ok":true,"service":"superclaw"}`。

---

### [x] Task 0.4 — 前端打开并记录功能清单

**AI 提示词**：
```
你是一位资深前端测试工程师，擅长产品功能走查。请验证 SuperClaw 网页前端在浏览器中的可用性，并产出功能清单。

执行：
1. 浏览器打开 http://localhost:8080
2. 确认 React 工作台能加载（不是白屏 / 不是 404）
3. 逐一走查主要界面，记录每个的状态（可用 / 报错 / 空数据）：
   - 聊天 Chat 界面
   - 团队工作台 Team Workbench（issues、agents、approvals）
   - 设置 Settings（preferences、account、security、runtime、diagnostics）
   - 能力工坊 Capability Workshop
   - 运行 Runs / 目标 Goals
4. 打开浏览器开发者工具，记录 Console 报错与失败的网络请求（哪些 /api/* 返回非 200）
5. 产出一份《基线功能清单》写入 specs/baseline-功能清单.md：
   - 表格：功能模块 | 状态 | 备注（报错信息 / 缺失原因）
   - 重点标注：chat 是否能发消息、是否需要 relay key、哪些功能依赖外部服务

注意：main 分支是旧的纯 Python 架构，chat 不含 Paperclip Node；无 relay key 时 chat 可能跑不出真答案，但 UI 与链路应可见。
```

**验收**：前端能打开，`specs/baseline-功能清单.md` 产出，明确哪些能用、哪些不能用。

---

## 🔵 验收检查点 1：Docker 基线验收

> **到这里停下来，汇报后等用户确认再继续。**
- [x] Task 0.1-0.4 完成
- [x] 容器能跑、`/health` 通、前端能开
- [x] 产出基线功能清单，明确 chat 现状（`specs/baseline-功能清单.md`）
- **决策点**：基线确认后，是否继续上 node 分支双服务端？Windows 下 Python 用 Docker 还是装 WSL2？

---

## 阶段 1：双服务端验证（node 分支，Node + Python）

> 完成 Leon WIP 第 10 步：浏览器端到端验证新 chat 链路。

### [x] Task 1.1 — 切 node 分支，熟悉 server/ 并装 Node 依赖

**AI 提示词**：
```
你是一位资深 Node.js / TypeScript 全栈工程师，精通 pnpm monorepo。请在 node 分支上准备 Paperclip Node 服务端的运行环境。

执行：
1. git checkout node（先 git stash 或确认工作区干净）
2. 阅读 docs/server-coexist-WIP-status.md，掌握 6/11 进度与启动方式
3. 阅读 server/package.json，理解 monorepo 结构（pnpm workspace，packages: adapter-utils/adapters/db/mcp-server/plugins/shared/skills-catalog/teams-catalog）
4. 检查本机 pnpm 版本（server 要求 pnpm@9.x，本机是 10.x，可能需要 corepack 切换或验证兼容）
5. cd server && pnpm install
6. pnpm -r build（构建所有 workspace 包）
7. 报告：依赖安装是否成功、构建是否通过、有无 TS 错误、pnpm 版本是否需要调整

注意：开发机是 Windows + Git Bash。server/ 的运维脚本是 bash 写的。若 pnpm install 因平台报错，定位是 postinstall 脚本还是原生依赖问题。
```

**验收**：`server/` 依赖装好、`pnpm -r build` 通过、无阻断性 TS 错误。

---

### [x] Task 1.2 — 为 Python 后端做容器化（绕过 Windows 崩溃）

**背景**：node 分支双服务端模式下，Python 后端要单独跑在 8810。但 Windows 原生跑 Python 内核会崩（`os.getuid()`/`fcntl`）。需用容器跑 Python 侧。

**AI 提示词**：
```
你是一位资深 Docker + Python 工程师。请为 node 分支的双服务端模式，让 Python 后端（apps/api）运行在 Docker 容器中，监听 8810 端口，从而绕过 Windows 原生运行的崩溃问题。

执行：
1. 确认 node 分支根目录已有的 Dockerfile / docker-compose.yml 是否可复用（main 的 Dockerfile 跑 8080）
2. 新增一个 compose 服务或 override，让 Python API：
   - 容器内跑 uvicorn apps.api.main:app
   - 映射到宿主机 8810 端口
   - 挂载必要的状态卷（/data）
   - 设置 PYTHONPATH=packages/superclaw/src:.
3. 启动并探活：curl http://localhost:8810/health → {"ok":true,"service":"superclaw"}
4. 验证容器内 Linux 环境没有触发 Windows 崩溃点（workspace_resolver / relay_key / backends）
5. 报告配置方式与探活结果

约束：不要改 Python 源码去"修" Windows 兼容（那是后续单独工作）；本任务只用容器规避。注释用中文。
```

**验收**：Python 后端容器化跑在 8810，`/health` 通。

---

### [x] Task 1.3 — 三服务联合启动

**AI 提示词**：
```
你是一位资深全栈联调工程师。请把 node 分支双服务端的三个服务同时拉起来，确认互通。

执行：
1. Node server（chat 引擎，3810）：cd server，设置 PAPERCLIP_HOME=~/.superclaw/server-node，pnpm dev
2. Python 后端（8810）：用 Task 1.2 的容器方式启动
3. Web（Vite proxy 分流，5180）：npm run dev --prefix apps/web
4. 确认 Vite proxy 配置：chat 相关路由（/api/chat、/api/workspaces、/api/runs、/api/backends、/api/agents、/v1/skills）→ Node:3810；其余 → Python:8810
5. 三服务全部 running 后，浏览器打开 5180，确认前端加载、无致命 Console 报错
6. 报告：三服务启动状态、端口监听、proxy 分流是否正确

注意：参考 docs/server-coexist-WIP-status.md 的"怎么跑/验证"小节。Windows + Git Bash 下注意环境变量写法。
```

**验收**：3810 / 8810 / 5180 三服务齐起，前端在 5180 加载。

---

### [x] Task 1.4 — 配置 relay key（让 chat 出真答案的前提）

**AI 提示词**：
```
你是一位资深 AI 后端工程师，熟悉 LLM 中转站（relay）密钥管理。请为 SuperClaw 配置可用的 relay key，使 chat 能调用真实模型。

执行：
1. 阅读 packages/superclaw/src/superclaw/relay_key.py 与 relay_packages.py，理解 key 的存储与解析
2. 阅读环境变量约定：SUPERCLAW_RELAY_BASE_URL 等（见 .env.example）
3. 确认从哪里获取 key（向用户索取测试 key，或用 ClawHunt 线上发放机制）
4. 配置 key 到正确位置（环境变量 / ~/.superclaw 配置）
5. 验证：superclaw relay status 或对应 API 能确认 key 有效、能查余额
6. 报告：key 配置方式、余额/可用模型清单

⚠️ 安全：relay key 是凭据，绝不写入代码、绝不提交、绝不打印明文到日志。需要用户提供 key 时明确告知。
```

**验收**：relay key 配好，能查到可用模型/余额。（若用户暂无 key，标记为阻塞并跳到 1.5 用 mock 验证 UI）

---

### [x] Task 1.5 — 浏览器 chat 端到端验证（Leon 第 10 步）

> **关键发现（新增）**：Node chat 引擎在 Windows 上同样不可用 —— acpx adapter 的 `writeAgentWrapper`
> **总是**写 `#!/usr/bin/env bash` 的 `.sh` 包装脚本再 spawn，Windows 报 `AgentSpawnError ...sh ENOENT`。
> 故双服务端在 Windows 上**两端都要 Linux 容器**（Node 也容器化）。另：`local_trusted` 强制 bind=loopback
> 与 Docker 发布端口（DNAT 投 eth0）冲突，用 `alpine/socat` 边车（共享网络命名空间，0.0.0.0:3810→127.0.0.1:3100）
> 桥接，服务端仍只 bind loopback、保住零鉴权安全模型、零上游改动。详见 `specs/chat-端到端验证报告.md`。

**AI 提示词**：
```
你是一位资深端到端测试工程师。请在浏览器里完整验证 node 分支的 chat 链路，对应 Leon WIP 文档的第 10 步。

逐项验证并记录结果：
1. 真聊天：在 5180 前端发一条消息 → 收到 AI 流式回复
2. 真切模型：对话途中切换 runtime / model / effort → 下一轮生效，旧上下文延续
3. 真绑 workspace：侧栏选一个 workspace → chat 归档进该 workspace、在其根目录执行
4. 流式渲染：工具调用卡片、推理块、token 用量卡片正常显示（DisplayProtocol）
5. 多轮记忆：连续多轮对话，确认跨轮 session resume 生效
6. 异常路径：无效输入 / 切到不支持的 model → fail-closed，不白屏不串数据

产出验证报告写入 specs/chat-端到端验证报告.md：
- 表格：验证项 | 结果（通过/失败） | 截图或日志 | 问题描述
- 对每个失败项，给出初步定位（前端 / Node / Python / proxy / relay）

注意：需 Task 1.4 的 relay key 才能验证真答案；若无 key，先验证 UI 交互与链路连通性，真答案项标注"待 key"。
```

**验收**：`specs/chat-端到端验证报告.md` 产出，chat 核心链路验证完成。

---

## 🔵 验收检查点 2：chat 端到端验收

> **到这里停下来，汇报后等用户确认再继续。**
- [x] Task 1.1-1.5 完成
- [x] 三服务能联合启动，前端可用
- [x] chat 端到端验证报告产出（真聊天 / 切模型 / 绑 workspace）
- **决策点**：chat 跑通后，是否进入 ClawHunt 嵌入联调？还是先补 WIP 剩余步骤（8/9）？

---

## 阶段 2：SuperClaw ↔ ClawHunt 联调

> 待阶段 1 跑通后细化。以下为框架性任务，执行前需先做现状评估。

### [ ] Task 2.1 — 评估并决定 bump 版本

**AI 提示词**：
```
你是一位资深架构师，擅长依赖版本决策。请评估 ClawHunt 嵌入层应锁定到 SuperClaw 的哪个版本。

执行：
1. 阅读 clawproduct-hunt/superclaw.lock（当前锁 db474fb8，落后 main 140 提交）
2. 阅读 clawproduct-hunt/backend/superclaw_embed/ 的 spawn 契约（它起 apps.api.main，纯 Python）
3. 关键判断：嵌入层 spawn 的是 Python apps/api。node 分支是双服务端（含 Node），嵌入层目前不支持起 Node server
4. 给出建议：
   - 选项 A：bump 到 main 最新（纯 Python，嵌入层无需大改，但 chat 是旧架构）
   - 选项 B：等 node 分支合入 main 后再 bump（chat 新架构，但嵌入层需支持双进程）
   - 权衡各自的工作量、风险、对"网页版 chat 质量"的影响
5. 产出决策建议文档 specs/嵌入版本决策.md，列清两条路的代价

ultrathink：这是影响后续大量工作的架构岔路口，要把双服务端对嵌入层的冲击讲透。
```

**验收**：`specs/嵌入版本决策.md` 产出，明确 bump 策略与代价。

---

### [ ] Task 2.2 — 前端嵌入 + JWT 注入

**AI 提示词**：
```
你是一位资深全栈工程师，精通跨应用前端嵌入与鉴权透传。请把 SuperClaw 前端嵌入 ClawHunt 的 /superclaw 子路由。

执行（依赖 Task 2.1 的版本决策）：
1. 阅读 clawproduct-hunt/backend/superclaw_embed/README.md 的"前端嵌入"待办
2. 配置 apps/web 在 /superclaw 子路由下加载，fetch base 指向嵌入网关
3. 注入 ClawHunt JWT：身份以 hunt 鉴权为准，透传到 SuperClaw（绝不信任客户端的 X-SuperClaw-Token）
4. 验证：ClawHunt 登录用户访问 /superclaw → 加载 SuperClaw 前端、鉴权一致
5. 报告嵌入方式与验证结果

coding with gemini：前端嵌入涉及大量 UI 与路由改动，适合长上下文处理。
```

**验收**：ClawHunt `/superclaw` 能加载 SuperClaw 前端，JWT 鉴权打通。

---

### [ ] Task 2.3 — 真答案 + 多租户隔离验证

**AI 提示词**：
```
你是一位资深安全测试工程师，专注多租户隔离。请验证嵌入后的真实可用性与租户隔离。

执行：
1. 用真 relay key，在 ClawHunt /superclaw 里发起聊天 → 收到真实 AI 回复
2. 多租户隔离：用两个不同 ClawHunt 账号同时使用 → 验证数据/凭据/会话/文件不串
3. 参考 superclaw_embed 的隔离三轴（会话数据 / 凭据计费 / 能力权限）逐轴验证
4. 验证 sandbox policy（mode=plan 只读）与越权中和生效
5. 产出隔离验证报告 specs/多租户隔离验证.md

⚠️ 重点核对 superclaw_embed/README.md 的两条硬约束：单 worker 单实例、OS 级沙箱兜底。
```

**验收**：真答案出来、多租户隔离验证通过。

---

## 🔵 验收检查点 3：ClawHunt 联调验收

> **到这里停下来，汇报后等用户确认再继续。**
- [ ] Task 2.1-2.3 完成
- [ ] 用户能在 ClawHunt 里用 SuperClaw 聊天、出真答案、租户隔离正确

---

## 阶段 3：性能优化 + 功能补全（待前序跑通后细化）

### [ ] Task 3.1 — 性能 profiling 与优化
**AI 提示词**：
```
你是一位资深性能工程师，精通分布式系统可观测性。请对 SuperClaw 网页版做性能 profiling 并优化。
方向：SSE 流式延迟、进程冷启动时间、并发租户承载、前端首屏。先测量定位瓶颈，再针对性优化，每项给出前后对比数据。
```

### [ ] Task 3.2 — WIP 剩余步骤补全 + 全量 CI
**AI 提示词**：
```
你是一位资深交付工程师。请补全 Leon WIP 文档剩余步骤（第 8 步 runAgentTurn 抽核、第 9 步全局 skill/plugin union），并跑通完整 ci.yml 交付门（pytest / npm test / build / ruff）。
每个改动遵循 CLAUDE.md 的验收铁律（Codex + Gemini 批判性验收后再提交）。
```

---

## 🔵 验收检查点 4：交付验收

- [ ] Task 3.1-3.2 完成
- [ ] 性能达标、功能补全、全量 CI 通过
- [ ] 网页版可交付上线

---

## 任务依赖图

```
Task 0.1 (.dockerignore)
   └─→ 0.2 (build) ─→ 0.3 (探活) ─→ 0.4 (功能清单)
                                        │
                              🔵 检查点 1
                                        │
Task 1.1 (Node 依赖) ─┐
Task 1.2 (Python 容器)─┼─→ 1.3 (三服务联合) ─→ 1.4 (relay key) ─→ 1.5 (端到端)
                       │                                              │
                                                            🔵 检查点 2
                                                                      │
Task 2.1 (版本决策) ─→ 2.2 (前端嵌入) ─→ 2.3 (隔离验证)
                                              │
                                    🔵 检查点 3
                                              │
Task 3.1 (性能) + 3.2 (补全+CI) ─→ 🔵 检查点 4
```

---

## 下一步

当前在 **Task 0.1**。说"继续"即开始执行 Task 0.1（创建 .dockerignore）。
