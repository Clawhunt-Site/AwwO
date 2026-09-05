# updatePRD v1 —— SuperClaw 网页版独立跑通与联调

> 版本：v1 | 日期：2026-06-28 | 负责人：LK
> 目标：**把 SuperClaw 网页版做好、拉通联调、优化性能、实现功能**
> 前置策略：**先确认 SuperClaw 独立能跑通 chat（线 A），再嵌入 ClawHunt（线 B）**

---

## 📍 当前进度（2026-06-28 更新）

> **一句话：阶段 0、阶段 1 已全部跑通——SuperClaw 网页版能独立在浏览器里聊天、出真答案、切模型、绑 workspace。现停在「验收检查点 2」，等业主拍板阶段二方向。**

| 阶段 | 状态 | 结论 |
|------|------|------|
| 阶段 0 — Docker 基线（main 纯 Python） | ✅ 完成 | 容器跑通、`/health` 通、前端能开。基线 chat 为旧架构 |
| 阶段 1 — 双服务端验证（node 分支） | ✅ 完成 | **浏览器端到端跑通**：真聊天 / 真切模型 / 真绑 workspace 全部验证 |
| 阶段 2 — ClawHunt 联调 | ⏸ 待启动 | 等业主在检查点 2 选方向（直接联调 / 先补 WIP） |
| 阶段 3 — 性能 + 功能补全 + 交付 | ⏳ 未开始 | — |

**阶段 1 关键成果与发现：**
1. **环境决策已定**：Windows 下 Python 服务端用 **Docker Desktop**（非 WSL2）。
2. **relay key 已配**：业主提供默认分组 key（注入容器环境变量，不入库），gate `gate.clawhunt.site` 经验证同时支持 Anthropic / OpenAI 双协议，chat 出真答案。
3. **新发现：Node chat 引擎在 Windows 上同样不可用**——acpx adapter 总是写 `#!/usr/bin/env bash` 的 `.sh` 包装脚本再 spawn，Windows 报 `ENOENT`。**结论：双服务端在 Windows 上两端都要 Linux 容器**（不止 Python 端）。
4. **bind 冲突解法**：`local_trusted` 模式强制服务端 bind=loopback，与 Docker 发布端口（DNAT 投 eth0）根本冲突。用 `alpine/socat` 边车（共享网络命名空间，`0.0.0.0:3810→127.0.0.1:3100`）桥接，**零上游代码改动**、保住零鉴权单用户安全模型。
5. 端到端证据见 `specs/chat-端到端验证报告.md`；任务勾选见 `specs/updatePRDv1-PLAN.md`。

**🔵 当前停在「验收检查点 2」，需业主决策：**
- 阶段二走 **A**（直接 ClawHunt 嵌入联调）还是 **B**（先补 Leon WIP 剩余步骤再联调）？
- 这批 Docker/配置改动是否现在走 Codex+Gemini 验收并原子化提交？

---

## 〇、背景与决策

### 核心诉求
SuperClaw 分**本地版**和**网页版**。当前核心工作是把**网页版**先做好：
1. 独立跑通（chat 端到端可用）
2. 拉通联调（前后端、双服务端打通）
3. 性能优化
4. 功能补全

### 关键约束
- **开发机是 Windows**，Python 内核有硬性崩溃（`os.getuid()`、`fcntl` 等），原生跑不起来
- **Docker Desktop 已就绪**（Engine running），用容器跑 Linux 环境可绕过 Windows 崩溃
- Leon 的双服务端方案进度 6/11，chat 基本完成但**从未在浏览器端到端验证过**

### 决策：分阶段验证
> 先拿能跑的基线，再逐步上最新架构，最后嵌入 ClawHunt。
> 不一上来就啃最复杂的双服务端 + 嵌入，避免一处卡死全盘停滞。

---

## 一、阶段规划

```
阶段 0  Docker 基线验证 (main 分支, 纯 Python)              ✅ 完成
   └─ 确认核心引擎在容器里能活、前端能打开
        │
阶段 1  双服务端验证 (node 分支, Node+Python)               ✅ 完成
   └─ Leon 第 10 步: chat 浏览器端到端 (真聊天/真切模型/真绑 workspace)
        │
        🔵 检查点 2（当前位置，等业主拍板阶段二方向）
        │
阶段 2  SuperClaw ↔ ClawHunt 联调                          ⏸ 待启动
   └─ 嵌入层打通, 真 relay key 出真答案
        │
阶段 3  性能优化 + 功能补全 + 交付                          ⏳ 未开始
```

---

## 二、阶段 0：Docker 基线验证（main 分支）✅ 已完成

**目标**：用 Docker 把现有 main 分支的纯 Python 架构跑起来，验证核心引擎和前端在容器里正常工作。这是最稳的"先有一个能跑的东西"。

### 任务清单（全部通过，基线功能清单见 `specs/baseline-功能清单.md`）
| # | 任务 | 验收标准 | 结果 |
|---|---|---|---|
| 0.1 | `docker compose --profile superclaw build` 构建镜像 | 构建成功，无报错 | ✅ |
| 0.2 | `docker compose --profile superclaw up` 启动容器 | 容器 Running 状态 | ✅ |
| 0.3 | 探活 API | `curl http://localhost:8080/health` 返回 `{"ok":true,"service":"superclaw"}` | ✅ |
| 0.4 | 打开前端 | 浏览器访问 `http://localhost:8080` 能加载 React 工作台 | ✅ |
| 0.5 | 记录可用/不可用功能 | 哪些页面能开、哪些报错，列清单 | ✅ |

### 已知风险
- main 的 Docker 只跑 Python + 预构建前端，**chat 是旧架构**（不含 Paperclip Node）
- 没有真 relay key，chat 可能跑不出真答案（但能验证 UI 和链路）
- `docker compose up` 默认会带起 fusion 三件套（osiris/design/pencil），用 `--profile superclaw` 只起主服务

### 命令
```bash
cd C:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/SuperClaw
# 只起主 API + 前端 (不起 fusion 三件套)
docker compose --profile superclaw build
docker compose --profile superclaw up
# 另开终端探活
curl http://localhost:8080/health
```

---

## 三、阶段 1：双服务端验证（node 分支）✅ 已完成

**目标**：完成 Leon WIP 文档的第 10 步——在浏览器里端到端验证新 chat 链路。**已达成：浏览器（5180）经 proxy 出真答案。**

### 最终启动方式（双容器 + 宿主 Vite，全部容器化绕 Windows 坑）
> 与原计划差异：实测 **Node 引擎在 Windows 上也崩**（acpx 写 `.sh` 包装脚本 spawn → ENOENT），故 Node 端也容器化；不再宿主直跑 `pnpm dev`。docker-compose 见 node 分支 `docker-compose.node.yml`。
```bash
# node 分支工作树（c:/.../SuperClaw-node）
# 1+2) Node chat 引擎(3810, 容器+socat 边车) + Python 后端(8810, 容器) 一起拉起
docker compose -f docker-compose.node.yml up -d --build
# 3) Web (Vite proxy 分流, 端口 5180)
npm run dev --prefix apps/web
# 探活：curl http://localhost:8810/health      → {"ok":true,"service":"superclaw"}
#       curl http://localhost:3810/api/health   → {"status":"ok",...}
```

### 任务清单（全部通过，端到端证据见 `specs/chat-端到端验证报告.md`）
| # | 任务 | 验收标准 | 结果 |
|---|---|---|---|
| 1.1 | Node server 能启动 | 端口 3810 监听，无 TS 编译错误 | ✅ 容器内 `listening on 127.0.0.1:3100`，宿主 3810 经 socat 可达 |
| 1.2 | Python 后端能启动 | 端口 8810，`/health` 200（容器内） | ✅ 容器内 `{"ok":true}` |
| 1.3 | 前端能打开 | 端口 5180，工作台加载 | ✅ proxy 按路径正确分流到两容器 |
| 1.4 | 真聊天 | 发消息→收到 AI 回复（需 relay key） | ✅ opus-4-8 / sonnet-4-6 均出真答案 |
| 1.5 | 真切模型 | 对话途中切换 runtime/model/effort 生效 | ✅ 模型透传 relay 真校验（haiku-4-6 被正确拒） |
| 1.6 | 真绑 workspace | 侧栏选 workspace，chat 归档进去 | ✅ 非法 uuid fail-closed 400；无绑定自动 fallback |
| 1.7 | 流式渲染 | 工具调用/推理/用量卡片正常显示 | ✅ SSE 事件流完整（已验证接口层；UI 可视化回归待补） |

### 已知阻塞（均已解决）
- ~~**Python 侧 Windows 崩溃**~~ → 用 Docker 容器跑（`Dockerfile.api`，宿主 8810）✅
- ~~**Node 分支无统一 Docker**~~ → 新写 `docker-compose.node.yml`（双容器 + socat 边车）✅
- ~~**Node 引擎 Windows 崩溃**（新发现）~~ → Node 也容器化（用 server/ 自带上游 Dockerfile）✅
- ~~**relay key**~~ → 业主提供默认分组 key，注入容器环境变量 ✅

---

## 四、阶段 2：SuperClaw ↔ ClawHunt 联调

**目标**：把 SuperClaw 嵌入 ClawHunt，用户能在 clawhunt.store 里用 SuperClaw 聊天。

### 现状
- ClawHunt 侧已有完整嵌入层 `superclaw_embed/`（多租户隔离、进程管理、代理透传）
- agent 链路已通到模型调用边界
- `superclaw.lock` 锁定 SHA `db474fb8`，**落后 main 140 个提交**

### 任务清单
| # | 任务 | 验收标准 |
|---|---|---|
| 2.1 | 决定 bump 到哪个版本 | main 最新？还是 node 分支？需评估 |
| 2.2 | 更新 superclaw.lock | sync_superclaw.sh 校验 HEAD==SHA 通过 |
| 2.3 | 前端嵌入 | ClawHunt `/superclaw` 子路由加载 SuperClaw 前端 |
| 2.4 | JWT 注入 | ClawHunt 身份透传到 SuperClaw，鉴权一致 |
| 2.5 | 真 relay key 出真答案 | 用户聊天能收到真实 AI 回复 |
| 2.6 | 多租户隔离验证 | 两用户数据/凭据/会话不串 |

---

## 五、阶段 3：性能优化 + 功能补全

> 待阶段 0-2 跑通后细化。初步方向：

- **性能**：SSE 流式延迟、进程冷启动、并发租户承载
- **功能补全**：Leon WIP 剩余步骤（详见 `specs/updatePRDv2.md`：第 7/8/9/11 步，第 10 步已完成）
- **交付门**：完整 CI 跑通（pytest / npm test / build / ruff）

---

## 六、当前待办

**已完成：**
- [x] **阶段 0.1-0.5**：Docker 跑通 main 基线，`/health` + 前端可用，基线功能清单已出
- [x] **环境决策**：Windows 下 Python（及 Node）服务端统一用 **Docker Desktop**
- [x] **阶段 1.1-1.7**：双服务端浏览器端到端跑通（真聊天 / 切模型 / 绑 workspace）

**待业主决策（检查点 2）：**
- [ ] **阶段二方向**：A 直接 ClawHunt 嵌入联调 ｜ B 先补 Leon WIP 剩余步骤
- [ ] **是否现在提交**：这批 Docker/配置改动走 Codex+Gemini 验收 → 原子化 commit

---

## 七、关键信息速查

| 项 | 值 |
|---|---|
| Docker 主服务端口 | 8080 (main 纯 Python 基线) |
| Node server 端口 | 3810 (node 分支 chat 引擎，**容器内 socat→127.0.0.1:3100**) |
| Python 后端端口 | 8810 (node 分支双服务端，**容器内 8080**) |
| Vite dev 端口 | 5180 (node 分支，宿主直跑) |
| 双服务端 compose | `docker-compose.node.yml`（node 分支根目录，双容器 + socat 边车） |
| relay gate | `https://gate.clawhunt.site`（双协议：Anthropic + OpenAI；key 走容器环境变量） |
| 健康检查 | Python `GET /health` → `{"ok":true,"service":"superclaw"}`；Node `GET /api/health` → `{"status":"ok",...}` |
| 当前工作前沿分支 | `node`（node 分支工作树：`c:/.../SuperClaw-node`；main 工作树：`c:/.../SuperClaw`） |
| 嵌入层位置 | `clawproduct-hunt/backend/superclaw_embed/` |
| 版本锁 | `clawproduct-hunt/superclaw.lock` (SHA db474fb8，落后 main 140 commit) |
| WIP 状态文档 | `docs/server-coexist-WIP-status.md` (node 分支) |
| 端到端验证报告 | `specs/chat-端到端验证报告.md` |
