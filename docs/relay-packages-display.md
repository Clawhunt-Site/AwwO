# Relay 套餐（Package/Tier）展示 — 设计简报

> 目标：登录 ClawHunt 账户后，superClaw 各表层（CLI / API / Web）展示的不再是 LLMgate
> 的**裸模型列表**（`GET /v1/models`），而是 **super 分组返回的几个设置好的套餐**
> （core / plus / max…）。这是把 ClawHunt 主站 `clawproduct-hunt` 后端**已经提供的
> 「super 套餐」解决思路**移植进 superClaw 内核——只参考其 **LLMgate 套餐的使用/设计逻辑**，
> 不引入 ClawHunt 的其他业务。

## 1. 设计来源（ClawHunt `clawproduct-hunt` 后端）

| 角色 | 文件 | 要点 |
|------|------|------|
| 套餐归一化 | `backend/utils/superclaw_tier.py` | tier 常量 `("core","plus","max")` + `SUPERCLAW_RELAY_GROUP_SLUGS` 映射到隐藏 group `superclaw-core/plus/max`；`*_from_groups` / `*_from_catalog` / `default_*` / `normalize_*` / `relay_group_slug_for_package` 转换族。 |
| LLMgate 传输 | `backend/utils/llmgate_relay.py` | `list_relay_groups()` → `GET /api/v1/groups`；`list_relay_package_catalog()` → `GET /api/v1/{CLAWHUNT_RELAY_PACKAGES_PATH=bridge/packages}`；`_api_v1_url()` 把 base 末尾 `/v1` 去掉再拼 `/api/v1/...`。**fail-safe**：失败一律返回空，由上层降级。 |
| 编排 + 端点 | `backend/api/agent_chat.py` `_relay_packages()` + `GET /api/agent-chat/relay-models` | 优先级：① 动态目录 → ② groups → ③ 硬编码默认。响应 `{available, models:[{id,name,tier,group_slug}]}`。聊天请求里 `model` 字段填**套餐 id**（非裸模型），后端 `relay_group_slug_for_package()` 翻成 `superclaw-plus` 再发 relay。 |

关键设计原则（照搬）：
1. **ClawHunt 永不暴露 LLMgate 裸模型 id**，只暴露套餐/tier 抽象。
2. 套餐**动态从 relay 取**，失败降级到硬编码默认（core/plus/max），永不报错卡死。
3. 每个套餐映射到一个 relay group slug（`plus` → `superclaw-plus`）。
4. 套餐选择经聊天请求的 `model` 字段传递，**发 relay 前翻译成 group slug**。

## 2. superClaw 现状（要替换的链路）

- 登录：`clawhunt_auth.py` → `~/.superclaw/clawhunt-auth.json`（access_token）。
- relay key：`relay_key.py` bridge exchange → ensure key；`resolve_relay_base_url()`
  默认 `https://gate.clawhunt.site/v1`（已过 `validate_relay_base_url` 安全校验）。
- **模型发现（要换的点）**：`model_discovery.py::_probe_clawwork()` → `GET /v1/models`
  → 裸模型 id 列表 → `ModelCatalog.models: list[str]`。
- API：`GET /api/agents/{backend}/models` → `ModelCatalog.to_dict()`。
- Web：`App.tsx` 的 `modelCatalogs` → clawwork 后端的模型下拉。
- CLI：`superclaw models clawwork`；relay 只读查询已有 `relay balance` / `relay usage`。

## 3. 落地方案（移植，分层）

### 3.1 内核 `relay_packages.py`（新模块，纯净）
- 移植 `superclaw_tier.py` 的 tier 常量与转换族（`packages_from_groups` /
  `packages_from_catalog` / `default_relay_packages` / `_package_from_identifier` /
  `_dedupe_packages` / `normalize_relay_package_id` / `relay_group_slug_for_package`）。
- `relay_packages(*, transport=None) -> dict`：
  - `available = relay 已配置 且 已登录（resolve_relay_api_key 有 key）`。
  - 已登录才发**实网查询**：catalog `/api/v1/bridge/packages` → groups `/api/v1/groups`
    → 默认。未登录返回默认 floor + `available=false`。
  - 复用 `resolve_relay_base_url()`（已校验）+ `relay_balance` 同款安全 httpx
    姿态：`trust_env=False`、`follow_redirects=False`、`transport` 注入测试。
  - **fail-safe**：任何网络/解析异常 → 降级默认，绝不外抛。
  - 返回 `{"packages":[{id,name,tier,group_slug}], "source":"catalog|groups|default", "available":bool}`。
- 可选 admin token 沿用 ClawHunt env 名：`CLAWHUNT_RELAY_PACKAGES_PATH`、
  `CLAWHUNT_BRIDGE_CATALOG_TOKEN`、`CLAWHUNT_RELAY_GROUPS_TOKEN`。
- 契约集中：默认套餐列表 + tier→slug 映射经 `ui_contracts.py` 再导出
  （`build_relay_packages_contract()`），前端不硬编码。

### 3.2 CLI `superclaw relay packages [--json]`
- 与 `relay balance` / `relay usage` 同风格；列出套餐 id/name/tier 与 source/available。

### 3.3 API `GET /api/relay/packages`
- 返回 `relay_packages()`，与 CLI 零偏差。`require_control_token` 守卫同其他端点。

### 3.4 Web 套餐选择器
- clawwork/relay 后端：模型下拉换成调 `/api/relay/packages` 的套餐选择器，显示套餐名/tier；
  登录后（available）才显示。其余后端模型下拉不变。

### 3.5 执行链跑通（套餐→group_slug）
- 选中套餐（如 `plus`）→ 发 relay 前 `relay_group_slug_for_package("plus") = "superclaw-plus"`。
- 核查 `backends.py` clawwork 把 `--model` 注入 clawrelay provider 的路径，确认翻译注入点。

## 4. 不变量 / 铁律对照
- **CLI 唯一事实源**：套餐逻辑先进内核（`relay_packages.py`），CLI/API/Web 调同一份。
- **零偏差**：CLI 与 API 同一函数、同一响应 schema；Web 不硬编码套餐。
- **fail-closed/安全**：base 经 `validate_relay_base_url`；`trust_env=False` +
  `follow_redirects=False` 防 key/重定向外泄；查询 fail-safe 不卡死。
- **表层只表现**：Web 只换「如何展示」（套餐 vs 裸模型），不新增内核没有的业务语义。

## 5. 已知取舍
- 当前 LLMgate（gate.clawhunt.site）是否已暴露 `/api/v1/groups`、`/api/v1/bridge/packages`
  未知；与 ClawHunt 一致按 **fail-safe** 处理：未暴露则展示默认 core/plus/max。
- 套餐 id 用短名（core/plus/max）展示，group slug 仅在发 relay 时翻译，UI 不暴露 slug。

## 6. 裸模型覆盖逃生口（有意保留，operator / control-token 级）

clawwork 的「模型」有三个设置入口，三者权限与边界不同：

| 入口 | 谁能用 | 行为 |
|------|--------|------|
| Web 套餐选择器 | 任何用户 | **闭集 Dropdown**，只能选套餐，无法手输裸模型 |
| `SUPERCLAW_CLAWWORK_MODEL` 环境变量 | 能改进程环境者（部署/operator） | 非套餐值**原样透传**给 relay |
| API 请求 `model_override` 字段 | 能调 API 者（需 control-token） | 非套餐值**原样透传**给 relay |

`ClawWorkBackend._translate_relay_package_model` 的规则：值是已知套餐（短名/动态套餐 id）→
翻成 group slug；**否则原样透传**。因此后两个入口可绕过套餐抽象、直接指定一个 relay 背后的
裸模型 id。

**这是有意保留的 operator / control-token 级覆盖逃生口**（与 `SUPERCLAW_RELAY_API_KEY`
那类高级覆盖同性质），**未来或许有用**（运维侧临时指定任意模型做诊断/灰度），**故刻意不
fail-close**：

- 铁律「永不暴露裸模型」针对的是**展示 / 选择面**（CLI `models`、API `/api/agents/*/models`、
  Web 下拉）—— 这些已全部只显示套餐、并彻底关掉裸 `/v1/models` 通道。
- 这两个入口**不属于展示面**：门槛是「已能改进程环境」或「已持有 control-token」的高权限主体，
  本就具备越权能力，等同既有的 key / base-url 覆盖逃生口。
- 准确叫法是 **operator / control-token 级覆盖**，不要简称「env 逃生口」（API `model_override`
  也是同一入口）。

若未来要收紧，方案备选：① 维持现状；② `_translate_relay_package_model` 对非套餐值 fail-closed
（拒绝/回落 relay 默认）；③ 加显式开关（如 `SUPERCLAW_CLAWWORK_ALLOW_RAW_MODEL=1`）默认
fail-closed。当前**选①保留**。

> 验收留痕：Codex(gpt-5.5) 三轮 + Antigravity(gemini-3.5-flash) 对抗验收，本项判为
> **advisory（非阻断）**，业主确认保留。
