# 本地会话 / Run 查询指南（state.db 架构 + 排查方法）

> 目的：根据一个从 SuperClaw WebUI/App 复制出来的 ID（`session_*` / `run_*` /
> `workspace_*` / `msg_*` 或一段 hex 片段），**快速、可靠地**定位到正确的本地数据库并
> dump 出对话内容，**绝不再查错库**。配套工具：`scripts/superclaw_session_lookup.py`，
> 配套技能：`.claude/skills/session-lookup/`。

## 1. 为什么会"查错库"——多 state.db 架构

SuperClaw 把状态写进 **`<cwd>/.superclaw/state.db`**，路径相对于**进程的工作目录**。
而同一台机器上跑 SuperClaw 的进程有很多种，cwd 各不相同：

| 表层 | 典型 cwd | 对应 state.db |
| --- | --- | --- |
| 装机版 App（`/Applications/SuperClaw.app`）后端 | 显式 `SUPERCLAW_DESKTOP_WORKDIR`；未设则 `~/Library/Application Support/SuperClaw`（桌面壳已不再隐式探测 cwd / `~/Documents`） | `<该 cwd>/.superclaw/state.db` |
| `npm run dev` + `superclaw service`（开发） | 仓库根，例如 `~/dev/superClaw` | `~/dev/superClaw/.superclaw/state.db` |
| 各 git worktree | `~/superclaw-wt/<分支>` 等 | 每个 worktree 各一份 |
| 旧的/废弃的桌面 runtime-cwd | `~/Library/Application Support/SuperClaw/runtime-cwd` | 常为**空库**（schema 在、无数据） |

所以一台机器上有**十几份 `state.db`**。光看文件存在与否毫无意义——必须找到**当前真正
在跑的那个服务**用的是哪一份。

### 陷阱：陈旧的 `desktop-service.json`

每个服务在 `<cwd>/.superclaw/run/desktop-service.json` 留一个标记，形如：

```json
{"base_url": "http://127.0.0.1:63497", "control_token": "…",
 "state_path": ".superclaw/state.db", "owned": false, "pid": 58886}
```

**问题**：服务退出后这个文件不会自动失效，`pid` 会指向一个**已死的进程**，它旁边的库
往往是**空的或过时的**。如果你随手挑一个 `desktop-service.json` 就信它，极易查到一个
"`chat_sessions / runs / events` 全是 0"的空库，然后误判"这个 ID 不存在"。

> 实战教训（2026-06-23）：排查 `session_8c842c90314d` 时，先信了 Application Support 下
> 那个 `desktop-service.json`（pid 83610，**已死**，库为空），得出"查不到"的错误结论。
> 真正活着的服务是装机版 App（pid 58886，cwd=`~/Documents/superClaw`），会话一直都在
> 那份 2.2MB 的库里。
>
> 注（后续变更）：自桌面壳移除隐式工作区探测后，装机版**默认 cwd 已改为
> `~/Library/Application Support/SuperClaw`**（除非显式设 `SUPERCLAW_DESKTOP_WORKDIR`）。
> 上面的 `~/Documents/superClaw` 是当时旧构建的行为；现在 Application Support 下既可能是
> 活库、也可能是死标记，仍以"活着的 `desktop-service.json`"为准，别再按"Application Support
> 必空/必旧"的旧直觉判断。

## 2. 正确的解析算法（工具已实现）

1. **找活着的服务**：扫描所有 `.superclaw/run/desktop-service.json`，解析 `pid`，用
   `os.kill(pid, 0)` 判活。**活着的**那个标记，其 `<cwd>/<state_path>` 就是权威库。
   （标记位于 `<cwd>/.superclaw/run/desktop-service.json`，故 cwd = 标记往上三层。）
2. **死标记全部报告并跳过**，让选库过程可审计。
3. **兜底全盘扫描**：若 ID 不在活库里（可能是归档的/历史的，或服务没在跑），就扫描常见
   根目录下所有**有数据的** `state.db`，报告 ID 真正落在哪一份。
4. 永远优先用正在跑的服务的库，只有必要时才回退到扫描结果。

## 3. 只读打开的坑：必须看见 WAL

活跃服务以 **WAL 模式**持有数据库，最新写入可能还在 `state.db-wal` 里、尚未 checkpoint
进主文件。用 SQLite 时：

- ❌ `file:db?immutable=1` —— **会跳过 WAL**，漏掉最新数据（实测 124 vs 126 行，刚发生的
  会话就这样"消失"）。这是"查不到"的另一个隐蔽来源。
- ✅ `file:db?mode=ro` —— 只读且**尊重 WAL**，能看到活跃服务刚写入的行，又不会写库。

工具用 `mode=ro`，对活库安全且完整。

## 4. ID 类型与表

| ID 前缀 | 含义 | 主表 |
| --- | --- | --- |
| `session_*` | 一段聊天会话 | `chat_sessions(session_id, payload, workspace_id, archived)` |
| `run_*`（真实） | 一次 orchestrator 交付 run | `runs` / `events` / `evidence` |
| `run_*`（合成） | **聊天 turn 的记账 id，不是真 run** | 只出现在 `cost_events`，`runs` 表里**没有** |
| `workspace_*` | 工作区 | `workspace_profiles`，并作为 `chat_sessions.workspace_id` |
| `msg_*` | 单条消息 | 在 `chat_sessions.payload.messages[].message_id` 里 |

`chat_sessions.payload` 是 JSON：`title / created_at / updated_at / messages[] /
metadata{capability_surface, native_sessions, runtime} / workspace_id / archived`。
每条 message：`role / content / status / run_id / usage / elapsed_ms / message_id`。

## 5. "明明成功却显示 failed" 的根因（与本工具的诊断）

聊天 turn（尤其 native claude 直聊）虽然答案正常生成并落库，但 `/api/chat` 与
`/api/chat/stream` 会给前端返回/发出一个 **合成 `run_id`（`_id("run")`）**，它只用于
`cost_events` 记账，**从不在 `runs` 表建任何资源**。前端把它当 run 句柄去轮询
`/api/runs/<id>` + `/evidence` + `/events/snapshot`，三个全 **404**，于是渲染成一张
**失败的 run 卡**——即使对话本身成功。

本工具会：
- 列出本会话的 `cost_events` 合成 run_id；
- 在同目录 `uvicorn.log` 里精确比对**这些 run_id 是否被轮询且 404**，
  从而把"为什么显示 failed"解释清楚，而不是停在"查不到"。

> 该契约缺陷的彻底修复见对应改动/PR（让 runless 聊天 turn 不再发可轮询的 `run_id`，或前端
> 不对 runless turn 触发 run 轮询）。

## 6. 用法速查

```bash
# 按 ID dump（自动定位活库，并打印跳过的死标记）
python3 scripts/superclaw_session_lookup.py session_8c842c90314d

# 完整消息体 + 完整 metadata
python3 scripts/superclaw_session_lookup.py session_8c842c90314d --full

# 跳过日志关联（更快）
python3 scripts/superclaw_session_lookup.py run_fd8c92c91068 --no-logs

# 指定库
python3 scripts/superclaw_session_lookup.py <id> --db ~/dev/superClaw/.superclaw/state.db

# 只记得标题/大概时间 → 列最近会话
python3 scripts/superclaw_session_lookup.py --list --limit 30
```

输出顺序：选中的库与跳过的死标记 → 会话元信息 → 逐条消息 → `cost_events` →
`uvicorn.log` 中本会话 run_id 的 404 关联。
