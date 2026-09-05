# Paperclip → SuperClaw runtime 渠道匹配终审

> 审计基准:`third_party/open-design/apps/daemon/src/runtimes/defs/`(权威 harness,
> 16+ coding-agent CLI 的渠道访问定义,即 Paperclip 渠道知识的可本地核对来源)。
> 审计对象:`packages/superclaw/src/superclaw/backends.py` 的全部 worker backend。
> 日期:2026-06-10。结论先行:**已移植渠道的访问逻辑与权威定义逐项匹配**;两类
> 分歧均为有意为之并有理由(见"合法分歧"),本轮补齐了 2 个真缺口(grok argv
> 守卫 + `--effort` 透传)。

## 0. 两套 harness 的本质差异(读矩阵前必看)

open-design daemon 是**交互式聊天流式 harness**:prompt 走 stdin、输出走
stream-json 事件解析、权限一律放开(`bypassPermissions`/`--yolo`/`--force`),
因为人在 UI 里看着。SuperClaw backend 是**无头交付 worker**:prompt 是有界的
goal 渲染(历史 replay 上限 20 条/6000 字符)、输出整批收割 + worker 标记协议、
权限由内核 `PermissionPolicy`/preset 治理。因此"完美匹配"的判据是:**渠道访问
知识(二进制、子命令、flag、prompt 投递方式、失败形态、model 选择)一致**,
而非逐 flag 复制聊天 harness 的姿态。

## 1. 逐渠道矩阵

| 渠道 | 权威定义(OD def) | SuperClaw 实现 | 判定 |
|---|---|---|---|
| **claude** | `-p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages(探测门控)] [--model] [--add-dir…] --permission-mode bypassPermissions`,prompt 经 stdin,fallbackBins `openclaude` | `--print --output-format json\|stream-json --verbose --include-partial-messages --model <m> [内核权限 flags 或 --no-session-persistence --tools=] <prompt argv>`;stream 解析失败自动回退 batch json | **匹配**。分歧见 §2.1–2.3 |
| **codex (exec)** | `exec --json --skip-git-repo-check --sandbox workspace-write -c sandbox_workspace_write.network_access=true -c default_permissions=":workspace" [-C cwd] [--add-dir] [--model] [-c model_reasoning_effort]`,prompt stdin | `exec [MCP -c overrides] --skip-git-repo-check --sandbox workspace-write --cd <repo> [--dangerously-bypass-approvals-and-sandbox] [--model] <prompt argv>`;legacy `-q` 路径 + model fail-closed | **匹配**。分歧见 §2.4 |
| **codex (app-server)** | OD 无此渠道 | `thread/start`/`turn/start`/`thread/resume` JSON-RPC、流式 + 审批回调 + model 协商(真机回显验证) | **超出权威覆盖** |
| **opencode** | `run --format json [-m model]`,prompt stdin;MCP 经 `OPENCODE_CONFIG_CONTENT` 注入 | `run --format json --pure [--model] [--variant] [--dangerously-skip-permissions] <prompt argv>` + `"type":"error"` 假成功标记(真机抓到的 exit-0 auth 失败) | **匹配+**(治理与失败检测超出 OD)。MCP env 注入是未来插件投射的候选通道,见 §3 |
| **grok** | `-p <prompt>(value-required,stdin 不可)[--model] [--effort low/medium/high/xhigh/max]`(CLI 有此 flag) + `maxPromptArgBytes` argv 守卫 | `[--model] [--max-tool-rounds N] -p <prompt>` + `MAX_PROMPT_BYTES=96KiB` argv 守卫。**effort 故意不投射**:CLI 虽有 `--effort`,但无 Grok 模型可靠按 `reasoning_effort` 响应(grok-4 直接拒;grok-3-mini 仅 low/high;grok-4-fast/4.3 仅 none/low/medium/high),无 claude 式统一 ladder,故 `supports_effort=False` 且对显式 effort fail-closed | **匹配**(effort 为有意下线,见 backend docstring) |
| **cursor-agent** | `--print --output-format stream-json --stream-partial-output --force --trust [--workspace cwd] [--model]`,prompt 必须 stdin(无 `-` 哨兵) | `-p --output-format stream-json --workspace <cwd> --trust [--force(preset 驱动)] [--model] <prompt 位置参数>` + `MAX_PROMPT_BYTES` 守卫;真机 cursor-agent 2026.06.04 验证位置参数路径可用 | **匹配**。分歧见 §2.5 |
| **hermes** | `acp --accept-hooks`(ACP JSON-RPC 交互协议) | `--oneshot <prompt> [--model/--provider/--toolsets/--skills] --accept-hooks --yolo`(无头单发) | **匹配**(同一二进制的两个官方入口;交付 worker 用 oneshot 是正确 profile)。ACP 流式接入列为 follow-up |
| **openclaw / openclaw-gateway** | OD 无此渠道 | CLI(`--print` + args)与 WebSocket Gateway(Ed25519 设备签名、协议协商、配对)双通道,真机端到端 | **超出权威覆盖** |
| **http / anthropic / anthropic-agent / gemini(API-agent) / local** | OD 无对应(其 BYOK proxy 概念≈我们的 http backend) | 自有契约(文档化请求/响应、SSRF/OOM/redacting 防护) | **超出权威覆盖** |

## 2. 合法分歧(有意为之,逐条理由)

1. **claude prompt 走 argv 而非 stdin**。OD 用 stdin 防 Linux `E2BIG`/Windows
   `ENAMETOOLONG`(交互 prompt 无上限)。SuperClaw 的 worker prompt 是有界渲染
   (goal + ≤20 条/6000 字符 replay),macOS ARG_MAX≈1 MiB,远低于风险线;且
   `run_command` 的 DEVNULL-stdin 是全 backend 共享的防挂起契约。argv 受限的
   渠道(grok/cursor)已各自配 96 KiB 守卫,超限显式失败。
2. **claude `--include-partial-messages` 未做探测门控**。OD 探测 `--help` 防旧版
   报 unknown option。SuperClaw 仅在 streaming 路径传该 flag,且 stream 解析
   0 事件时自动回退 batch json(不带该 flag)——旧版 CLI 自愈,无需探测面。
3. **权限不复制 OD 的一律放开**。OD 硬编码 `bypassPermissions`/`--force`/
   `--yolo`(人盯着 UI)。SuperClaw 由内核 preset(ask/allow)逐 backend 映射到
   真实原生 flag,这是治理要求,属刻意更严,见 docs/permission-mode-framework.md。
4. **codex 不传 `--json` / `network_access` / `reasoning_effort` 覆写**。worker
   收割整批文本 + 标记协议,无需 JSONL 流;network/sandbox 姿态来自内核
   policy 映射;reasoning effort 对 codex 可经 `-c model_reasoning_effort` 透传,
   列为 follow-up(非渠道访问缺失,是可选调参)。
5. **cursor prompt 走位置参数**。OD 注明其 CLI 无 `-` stdin 哨兵因此选 stdin
   管道;我们真机验证位置参数同样被 `agent [prompt...]` 接受,且配了 argv
   守卫。两条都是该 CLI 的真实通道。

## 3. 已知 follow-up(非阻断,已记录)

- **opencode MCP 投射**:OD 证实 `OPENCODE_CONFIG_CONTENT` env 可单次注入 MCP
  服务器——是解除 opencode 插件投射 fail-closed 的候选实现通道。
- **hermes ACP 流式**:`hermes acp --accept-hooks`(JSON-RPC)可为聊天表面提供
  hermes 流式;交付 worker 保持 oneshot。
- **codex reasoning effort**:`-c model_reasoning_effort=<level>`(含 OD 的
  `clampCodexReasoning` 按模型族钳制知识)。
- **gemini CLI 渠道**:OD 的 def(`--output-format stream-json --yolo` + stdin +
  `GEMINI_CLI_TRUST_WORKSPACE=true` env)是现成配方;SuperClaw 当前的 `gemini`
  是 API-agent(B 类,自有工具循环),按渠道矩阵决策保留。
- **未移植的 OD 渠道**(aider/amr/antigravity/copilot/deepseek/devin/kilo/kimi/
  kiro/qoder/qwen/reasonix/trae-cli/vibe/pi):超出"CC/Hermes/OpenClaw 等主流渠道
  尽可能拿进来"的既定矩阵;pi 已拍板为 ClawWork experimental backend 方向
  (docs/clawwork-two-track-dev-plan.md)。

## 4. 本轮修复

- `GrokCliBackend`:补 `MAX_PROMPT_BYTES` argv 守卫(OD 对 grok 明确标注
  value-required `-p`,stdin 不可,必须前置防 E2BIG)。
  - **effort 后续下线**(更正早期方案):`grok` CLI 虽有 `--effort` flag,但无 Grok
    模型可靠按 `reasoning_effort` 响应(grok-4 拒;grok-3-mini 仅 low/high;
    grok-4-fast/4.3 仅 none/low/medium/high),无 claude 式统一 ladder。故
    `supports_effort=False`、契约 `supports_effort_selection=False`、对显式 effort
    fail-closed,并移除 `SUPERCLAW_GROK_EFFORT`(env/`runtime_config` spec 一并删)。
- 测试:`test_grok_backend_refuses_explicit_effort_fail_closed`(显式 effort→guard 拒;
  env 已无效)、`test_grok_backend_guards_oversized_argv_prompt`。
