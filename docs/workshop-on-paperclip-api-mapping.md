# 能力工坊 → Paperclip Node Server：API 盘点与全 Node 兼容映射设计

> 分支 `feat/workshop-paperclip-api`（基于长命主干 `dev/server-refactor` @ `963db77b`）。
> **本轮交付 = 设计映射，暂不写实现**（业主拍板）。
> **架构决策（业主拍板，覆盖旧 memory 的「验签暂留 Python」）：工坊全部重写为 Node 原生，含验签 / cosign / TUF / R2 / ClawHunt 客户端**。
> 唯一残留 Python 工具链 = 技能编译（ruff/mypy），性质等同 Node shell `tsc`/`eslint`，非「Python 当事实源」。

本文回答两件事：① 能力工坊面板实际用到的 Python 后端 API 都是什么；② 每个接口在 Paperclip Node server 里**如何用 Node 原生重写**（复用 Paperclip 封装 + 用 Node 原语复刻 super 的验签/分发栈），并与现 Python **保持密码学/契约一致**。

## 0. 范围与方法

- 「能力工坊」= Web `apps/web/src/App.tsx` 里 `pluginTitle`/`pluginsMarketplace`（中文「能力工坊」）板块：插件 / 技能 / 公司模板的浏览·安装·上传·配置·治理。
- **契约真相源 = 前端 TypeScript 类型**（`App.tsx` 1475–1905：`PluginStatusPayload` / `CatalogResolutionPayload` / `RegistryPluginInfo` / `MarketplaceCatalogPluginInfo` / `PluginRevocationPayload` / `PluginPolicyPayload` / `PluginConfigurationPayload` / `CapabilityUploadContract` / `CatalogContractPayload` / `EntitlementSyncPayload`）。Node 重写**必须逐字段对齐**，否则前端漂移。
- 后端现状 = `apps/api/main.py`（FastAPI）59 个工坊路由 + `packages/superclaw/src/superclaw/` 内核（被本设计当作**移植蓝本**，而非运行时依赖）。
- **零漂移铁律**：Node 服务的 path / method / 请求·响应 JSON 形状 / 错误码 / 治理门 = 与现 Python 完全一致；前端 `App.tsx` **不改一行**。

## 1. 工坊面板的精确 API 面（前端实际调用）

面板加载 `loadPluginControl()`（`App.tsx:9669`）并发拉取 11 个读端点；其余为交互动作。

### A. 面板加载读端点（11，`loadPluginControl`）
| # | METHOD path | Python 行 | 响应类型 | 性质 |
|---|---|---|---|---|
| 1 | `GET /api/plugins/status` | `4347` | `PluginStatusPayload` | 内核状态投影 |
| 2 | `GET /api/contracts/catalog` | `4909` | `CatalogContractPayload` | **静态契约** |
| 3 | `GET /api/contracts/capability-upload` | `4919` | `CapabilityUploadContract` | **静态契约** |
| 4 | `GET /v1/catalog` | `8038` | `CatalogResolutionPayload` | TUF/trust 解析 + ClawHunt |
| 5 | `GET /v1/plugins` | `8069` | `{plugins: RegistryPluginInfo[]}` | 注册表回退 |
| 6 | `GET /api/plugins/marketplace-catalog` | `4475` | `{plugins: MarketplaceCatalogPluginInfo[]}` | ClawHunt 旧市场 feed |
| 7 | `GET /v1/plugins/revocations` | `8213` | `PluginRevocationPayload` | 治理（撤销） |
| 8 | `GET /v1/policies/runtime` | `8217` | `PluginPolicyPayload` | 治理（策略） |
| 9 | `GET /api/plugins/github-catalog` | `4471` | `{plugins:[{plugin_id}]}` | **静态配置** |
| 10 | `GET /api/plugins/workshop-catalog` | `4501` | `{plugins: MarketplaceCatalogPluginInfo[]}` | ClawHunt 已发布 + **官方背书验签** |
| 11 | `GET /api/plugins/workshop-distribution` | `4654` | `{plugins:[{plugin_id,version}]}` | **R2 工件存在性** |

### B. 目录同步 / 详情 / 字节
`POST /v1/catalog/refresh`(`8060`, TUF 刷新·503 良性) · `GET /v1/catalog/trust/{id}/{version}`(`8043`, **信任链派生**) · `GET /v1/plugins/{id}/versions/{version}`(`8196`, 版本清单) · `GET /v1/plugins/{id}/versions/{version}/download`(`8200`, **包字节**) · `GET /api/plugins/{id}/logo`(`4351`, logo 字节)

### C. 安装 / 卸载（治理重区）
| METHOD path | Python 行 | 治理 |
|---|---|---|
| `POST /api/plugins/install` | `4410` | **签名验证**（云注册表 + root key） |
| `POST /api/plugins/install-github` | `4552` | **签名验证** + skill-origin 红线 |
| `POST /api/plugins/install-workshop` | `4716` | **官方 cosign** + **R2 拉取** + 摘要绑定 |
| `POST /api/plugins/install-local` | `4436` | 本地文件（skill 可免签） |
| `POST /api/plugins/uninstall` | `4882` | 删缓存 |

### D. 技能投影（super `skill_runtime`，**非** Paperclip company-skills）
`GET /api/plugins/skills/contract`(`4904`) · `GET /api/plugins/skills/projections`(`4931`) · `POST /api/plugins/skills/sync`(`4941`) · `POST /api/plugins/skills/unsync`(`4955`)

### E. 配置 / 密钥
`GET /api/plugins/{id}/configuration`(`4968`) · `POST /api/plugins/config/set`(`4979`) · `POST /api/plugins/{id}/configuration/options`(`5039`, **沙箱工具执行**) · `POST /api/plugins/{id}/configuration/action`(`5052`, **沙箱**) · `POST /api/plugins/secret/set`(`5072`) · `POST /api/plugins/secret/delete`(`5088`)

### F. 诊断
`GET /api/plugins/diagnostics`(`4363`) · `GET /api/plugins/diagnostics/events`(`4367`, **SSE**)

### G. 权益
`POST /v1/entitlements/sync`(`8204`)

### H. 开发者上传 / 发布（4 类 × init/artifact/verification/status，16 端点 `7830`–`7996`）
`/v1/developer/{plugins,capabilities,skills,companies}`，**签名 + 评审治理**。

### I. 技能构建（Python 工具链）
`POST /v1/skills/build`(`8151`) · `POST /v1/skills/import`(`8111`) · `POST /v1/skills/sync`(`8135`) · `GET /v1/skills`(`8093`) · `GET /api/contracts/skill-build`(`4914`)

### J. 市场命令 / 订单（紧邻工坊子面板）
`POST /api/marketplace/commands`(`9905`) · `GET /api/marketplace/orders`(`9991`) · `GET /api/marketplace/orders/{id}`(`10001`) · `POST /api/marketplace/orders/advance`(`10011`)

## 2. Paperclip Node server 侧现状（可复用 plumbing）

- **框架**：Express v5 + TS(ESM)；路由 `server/server/src/routes/*`，在 `app.ts:211–334` 经 `api.use(...)` 挂载；zod `validate()` 中间件；`authz.ts`（`assertCompanyAccess`/`assertInstanceAdmin`/`assertBoardOrgAccess`）；`errors.ts`（`HttpError` 族）；`services/*`；DB = **Drizzle + Postgres**；`logActivity` 审计；`publishGlobalLiveEvent`（含 SSE）。
- **已有插件体系**（`services/plugin-*.ts` + `schema/plugins.ts`）：registry/lifecycle/loader/config/secrets/tool-dispatcher/runtime-sandbox/job。模型 = **本地 npm 包插件**，可借其**安装/卸载/配置/密钥/诊断/沙箱**的 plumbing。
- **缺失项（grep 0 命中）**：`cosign / TUF / revocation / r2 / entitlement / marketplace` 无对应物 → 这些是 **Node 全新移植**（用 Node 原语复刻 super 内核语义）。

## 3. 兼容映射决策（逐簇，全 Node 原生）

两类：**[复用-plumbing]** 借 Paperclip 现成 service 实现外壳/存储；**[Node-移植]** 用 Node 原语把 super 内核逻辑（含验签）重写。**没有任何一条委派回 Python 运行时**（除技能编译工具链，见 §4.6）。**凡「下载/导入 skill/plugin/company」的安装簇（C/D/H/I），其取字节 + 落地导入一律走 §3.5 的 Paperclip 导入基座，super 只补缺源 + 验签门。**

| 簇 | 决策 | Node 落地 |
|---|---|---|
| A2/A3/A9 静态契约 | **Node-移植** | 把 `ui_contracts` 静态结构移成 TS 常量/JSON，逐字段对齐前端类型。无密码学，**第一刀候选**。 |
| A1 status | **Node-移植 + 复用** | 外壳 + 已装插件清单借 `pluginRegistryService`；cache root 等改读 Node 数据根。 |
| A4 `/v1/catalog` + A5 `/v1/plugins` + A6/A10 market/workshop-catalog | **Node-移植** | 移植 `catalog_resolver`（TUF/trust 合并 + 冲突）与 `capability_cosign`（官方背书验签）→ 见 §4.1/§4.2。ClawHunt 拉取走 Node fetch。 |
| A7 revocations / A8 policies / G entitlements / B trust 链 | **Node-移植** | 移植治理派生（撤销表、运行时策略、权益、`trust_state`/`catalog_resolver` 信任派生）。 |
| A11 workshop-distribution / B download / C install-workshop（R2） | **Node-移植** | R2 走 `@aws-sdk/client-s3`（§4.4）+ 摘要绑定 + 验签。 |
| C install / install-github（签名） | **Node-移植（验签）** | 移植 `plugins.verify_plugin_package` 全链（§4.2）：digest + 清单规范化 + 签名者分级 + provenance 门。 |
| C install-local / uninstall | **复用-plumbing + 移植门** | 借 Paperclip `plugin-lifecycle`/`plugin-registry`，叠加 super 的 skill-origin 红线与缓存模型。 |
| E 配置/密钥/选项/动作 | **复用-plumbing + 移植门** | 借 `plugin-config`/`plugin-secrets-handler`/`plugin-runtime-sandbox`；选项/动作的沙箱工具执行复用 Paperclip sandbox，治理门按 super 语义补齐。 |
| D skills 投影 | **Node-移植** | 移植 super `skill_runtime` 投影模型（与 Paperclip company-skills 不可混用，独立实现）。 |
| F diagnostics + SSE | **Node-移植 + 复用** | SSE 用 `publishGlobalLiveEvent`/原生 SSE；诊断聚合移植。 |
| H developer 上传 / I skills/build | **Node-移植 + 工具链** | 提交状态机 + 验签 Node 移植；**技能编译/类型检查**= Python 工具链 subprocess（§4.6 唯一残留）。 |
| J marketplace 命令/订单 | **Node-移植** | 移植 `marketplace_handler`/`marketplace_saga`（9 不变量 + 人审门），落到 Drizzle 表。 |

## 3.5 导入/下载基座适配（关键：复用 Paperclip 现有 import 层）

> 业主校准：**「从远端下载/导入 skill / plugin / company」这个动作本身 Paperclip 是有现成基座的**——不要另写平行安装链。super 只补 Paperclip 缺的部分（特有源解析 + 验签准入门 + 域/缓存调和），其余骑在 Paperclip 的 fetch + import 上。

### Paperclip 三类导入基座（实测入口）—— 安装落点是**实例级文件系统根目录，无 companyId**
> 业主校准（关键纠正）：Paperclip 的 plugin/skill **就是装进实例级根目录**，跟 super `cache_root` 同模型，**不需要 companyId**。先前文中「company 域 / local 锚公司」的张力是伪命题，已删。`companySkills` 表 / `importFromSource(companyId)` 是**另一层**（公司内分享 + star/fork/comment 的可选特性），**不是**工坊安装落点，本设计不走它。

| 能力类 | 复用入口 | 安装落点（实例级根） | 远端抓取 |
|---|---|---|---|
| **plugin** | `routes/plugins.ts POST /plugins/install` → `loader.installPlugin({packageName,version} \| {path})` + `pluginRegistryService` + `plugin-lifecycle`(installed→ready) | **`~/.paperclip/plugins/`**（`plugin-loader.ts:79` `DEFAULT_LOCAL_PLUGIN_DIR`，无 companyId）；预取字节落临时目录后以 `{path}` 喂入 | npm / 本地路径 |
| **skill** | 写入实例级 skills 根目录（runtime 直接读），镜像 super `skill_runtime` 投影 | **`~/.claude/skills/`**（`access.ts:214` `resolveClaudeSkillsDir`，可经 `$CLAUDE_HOME` 配置）+ 内置 managed skills 目录（`access.ts:171`） | github/local，经 `github-fetch` |
| **company** | `teams-catalog.ts`（`resolveCatalogTeamReference`/`agent_safe` importer）+ `companyPortabilityService`（company-as-code） | **实例化出一个新 company**（company 是实体非根目录，import = 新建，无输入 companyId） | 目录 catalog / 外部 import |

### 统一导入管线（super 工坊任意 kind 安装 = 5 段，复用 vs 移植泾渭分明）
```
[1 源解析]  super-移植: ClawHunt workshop feed / 签名云注册表 / R2 key / github release / 本地
                （这些源 Paperclip 没有 → super 补 Node 解析器）
      ↓
[2 取字节]  复用 Paperclip github-fetch（github 源）
            super-移植 Node R2 客户端 @aws-sdk/client-s3（R2 源）／签名云注册表客户端
      ↓
[3 验签门]  super-移植 Node（§4）：digest + cosign/verify_envelope + 签名者分级
            + provenance + revocation + entitlement。FAIL-CLOSED，验不过不进 [4]。
      ↓
[4 按 kind 导入]  复用 Paperclip 基座，按能力类路由（落实例级根，无 companyId）：
            plugin  → loader.installPlugin({path:<已验临时目录>}) + registry + lifecycle → ~/.paperclip/plugins/
            skill   → 写入实例级 skills 根 ~/.claude/skills/（镜像 super skill_runtime 投影）
            company → teams-catalog importer + companyPortabilityService（实例化新 company）
      ↓
[5 状态投影]  super status/cache 投影（PluginStatusPayload.cache_root 等）映射到上述实例级根
```
**净适配**：[2 取字节]+[4 导入] 复用 Paperclip；只有 [1] 中 Paperclip 缺的源（R2/签名云/ClawHunt）+ [3 验签门] 是 super-移植。适配层本体 = **「kind→Paperclip 基座」路由器 + 前置统一验签门**。

### 落点映射（已纠正：无 companyId，super cache_root ↔ Paperclip 实例级根，1:1）
- super `cache_root`(`~/.superclaw` plugins) **↔** Paperclip `~/.paperclip/plugins/`；super skill 投影 **↔** Paperclip `~/.claude/skills/`（实例级，runtime 直读）。`PluginStatusPayload.cache_root`/`*_url` 投影到这两个根。
- **不经 `companySkills`/`importFromSource(companyId)`**——那是公司内分享的另一层特性，工坊安装不走它，避免把实例级能力误塞进某业务公司。
- company 类 = 实例化新 company（import 即新建，无输入 companyId）。
- **provenance/红线保留**：经 Paperclip 基座导入不得绕过 super 的 skill-origin 红线与 provenance 门——[3 验签门] 必须在 [4] 之前裁决，Paperclip importer 只接「已验」产物。

## 3.6 运行时可见性/授权 = 走 Paperclip 原生（不另移植 super 装备门）

> 业主拍板（覆盖此前草案）：company 与 chat 都已走 Paperclip 逻辑，**super 旧的 plugin grant / per-company 装备门 / skill-origin 红线层冗余，不再移植**。能力的可见性与授权一律用 Paperclip 原生机制。对齐 [[paperclip-as-base-not-our-governance]]：Paperclip 底层设计为可信底座，硬门只留支付 + 对外扫描，旧 fail-closed 不是公理。

### Paperclip 原生可见性（即采用的语义，实测）
- **plugin**：启用 = **实例级**（`plugin.enabled` lifecycle）；工具注册进单一实例级 registry，`plugin-tool-dispatcher.listToolsForAgent` 对任意公司 agent 可见；per-company 差异在配置/密钥/managed-resources（`plugin-registry.ts:395 getCompanySettings`、`pluginEntities.companyId`/`isNull`）。→ 实例级装好且启用 = 全实例可调，**这就是采用的行为**。
- **skill**：实例级根（`~/.claude/skills/`）可发现；各公司/runtime 经 **`desiredSkills` 选择**（`PaperclipDesiredSkillEntry`/`readPaperclipSkillSyncPreference`）挑选生效。→ Paperclip 自带的 per-scope 选择即授权层，**够用，不另加门**。

### 唯一保留的 super 治理 = 安装时「产物验签」（≠ 运行时授权，别混）
- §4 的 cosign/TUF/digest/provenance 验的是**下载字节是不是真货**（产物可信），是 install 入口的准入；与「哪个公司能调」无关。
- 即：**`装备/授权` 走 Paperclip 原生；`产物可信` 走 super 移植验签**。两条线正交，[3 验签门] 只把关「真不真」，不再把关「谁能用」。

### parity 范围（业主拍板）：非信任关键校验骑 Paperclip 原生，不追字节级跨语言 parity
- super 移植的 verify **只强制信任关键门**：验签 / 摘要 / 撤销 / cosign / skill-origin 红线 / external_mcp curated-only。这些必须与 kernel 逐字节/逐例 parity（金标对拍）。
- **非信任关键校验**（如 manifest configuration 描述符的 UI 卫生校验：settings/secrets 类型/范围/正则/UI tier）遇到根本性 JS↔Python 跨语言边界（正则引擎方言、bigint 精度、urlparse/casefold 差异）时，**不追字节级 parity**——交给 **Paperclip 原生插件加载校验**。理由：配置块已被 super 验签覆盖（签名即信任门），其 UI 卫生不是安全门；强行字节级复刻两套语言引擎成本与价值不匹配，且违背「Paperclip 为可信底座」。
- 落地：`validate_manifest_configuration_contract` **不移植进 Node verify**（刀7 写过后按此决策回退）；verify 编排不含 config-contract 步。后续凡遇非安全校验的跨语言边界，默认同此处理。

## 4. 全 Node 移植规格（含验签——本设计的核心）

> 目标：Node 与现 Python（及跨仓 clawhunt 签名侧）**密码学/契约逐字节一致**。下列每点都给出 Python 蓝本、Node 原语、一致性风险。

### 4.1 信任原语 `trust_contracts.py` —— 移植奇点（跨仓逐字节一致）
Python 蓝本（`trust_contracts.py`）：
- 规范化 = **JCS / RFC 8785**：自定义 `_serialize`（非 `json.dumps`）+ 排键按 **UTF-16-BE** code unit（`_sorted_keys`）+ 独立 **NFC** 预归一（`nfc_normalize`）。签/验消息 = `JCS(NFC(signed))`。
- keyid = `"sha256:" + sha256( JCS({keytype, scheme, public_key}) ).hex()`；公钥先规范化成单一形 `ed25519:<canonical base64 of 32 bytes>`（拒非规范 base64）。
- 信封 = `{signed, signatures:[{keyid, sig}]}`；阈值按 **distinct keyid** 计；签名形 `ed25519:<base64 of exactly 64 bytes>`。Ed25519 确定性（RFC 8032）。

Node 移植：
- **不要直接用现成 JCS 库就当一致** —— 把 `_serialize`/`_sorted_keys`/`nfc_normalize` **逐行移植成 TS**（`server/.../trust/jcs.ts`），NFC 用 `String.normalize('NFC')`（注意 Python 递归归一结构，需复刻递归）。数字序列化按 RFC 8785（与 `_serialize` 对拍）。
- Ed25519：Node 用 `@noble/ed25519`（原生支持 32 字节 raw 公钥 / 64 字节 sig，最贴 super 的材料形）或内置 `crypto`（需 raw→DER 包装）。`compute_keyid`/`encode_public_key`/canonical base64 全部复刻。
- **一致性门**：从 Python 导出**金标向量**（envelope/keyid/canonical-bytes 三类，含 NFC 边界、surrogate、key 排序、数字边界），Node 单测必须逐字节命中（见 §5 刀 1 + §7）。

### 4.2 包验签 `plugins.verify_plugin_package` / `verifier.py`
Python 蓝本：digest `sha256:<64hex>`；`_canonical_manifest_for_digest`（`plugins.py:755`，又一处规范化，需对拍）；签名者分级 `classify_signer`→ root / explicit / local；`resolve_signature_trust` 执行准入门；provenance 门（install 入口必声明来源，fail-closed）；skill-origin `local` 免签例外（`skill_origin==True && provenance=='local'`）。
Node 移植：复刻 digest + 清单规范化 + 三级签名者分级 + provenance/skill-origin 门，**fail-closed 不弱化**；root 公钥经环境/烤入键（对齐 `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` / baked root）。

### 4.3 官方背书 `capability_cosign.verify_official_cosignature`
严格签名形检查（`ed25519:` 前缀 + 恰 64 字节 + canonical base64）→ keyid 必须**等于烤入官方键**的 keyid（非「任一有效签名者」）→ 独立重建 `signed core` → `verify_envelope`（§4.1）。Node 复刻：**验过才 stamp** `trust:'official'`；任何缺失/不匹配 → `False`（fail-closed）。

### 4.4 分发 R2 `capability_r2.py`
S3 兼容：`R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/region=`auto`，三桶（registry/artifact/submissions），配置文件 `~/.config/superclaw/cloudflare-r2.env`。Node 移植：`@aws-sdk/client-s3`（SigV4 由 SDK 处理）指向 R2 endpoint；配置经 §AGENTS 环境变量分档（dev/staging/prod 各自 bucket/endpoint，不硬编码）。

### 4.5 ClawHunt 市场客户端
`capability_atlas` / `marketplace_*` 对 ClawHunt 公开端点的拉取/命令。Node 移植：纯 HTTP（`fetch`），base URL 走环境分档（对齐 `CLAWHUNT_*`/`VITE_CLAWHUNT_*`）。

### 4.6 唯一残留 Python 工具链：技能编译
`POST /v1/skills/build`（`skill_build.build_and_install_skill_plugin`）对 Python 技能跑 ruff/mypy 编译+类型检查——**这是语言内在的工具链**，Node 无法用 JS 跑 Python 类型检查。处理：Node 编排，但实际编译 = `spawn` 一个 ruff/mypy 工具链 subprocess（**与 Node shell `tsc`/`eslint` 同性质，不是「Python 内核当事实源」**）。打包/签名/落缓存本身仍 Node 原生。这是「全 Node」下唯一诚实的工具链外援，需在交付说明里留痕。

## 5. 建议切片（每刀 = 一兼容模块 + Codex 单顾问 + 本地原子提交；本轮不执行）

1. **刀 1 — 信任原语 + 金标向量（奇点，最先）**：移植 `trust/jcs.ts`（JCS+NFC+排键）+ `trust/envelope.ts`（Ed25519 + keyid + verify_envelope），用 Python 导出的金标向量逐字节锁死。**一切验签的地基，先过这关其余才有意义。**
2. **刀 2 — 静态契约**：`contracts/catalog`、`capability-upload`、`github-catalog` → `routes/workshop-contracts.ts`，对齐前端类型 + vitest。证明路由骨架 + 零漂移。
3. **刀 3 — 读面 + 目录解析**：`status`、`/v1/catalog`、`/v1/plugins`、marketplace/workshop-catalog（官方 cosign 验签，依赖刀 1）、revocations、policies。
4. **刀 4 — 包验签 + 安装/卸载**：`verify_plugin_package` 移植 + install/install-github/install-local/uninstall + skill-origin 红线。
5. **刀 5 — R2 分发**：workshop-distribution / download / install-workshop（R2 + 摘要绑定）。
6. **刀 6 — 配置/密钥/沙箱**：configuration / config-set / options / action / secret。
7. **刀 7 — 技能投影 + 编译**：skills 投影族 + skills/build（§4.6 工具链）+ developer 上传族。
8. **刀 8 — 诊断 SSE + marketplace saga**：diagnostics(+SSE) + marketplace 命令/订单。

## 6. 零漂移 + fail-closed 不变量（每刀必核）

- path/method/请求体/响应 JSON 形状/错误码/治理门 = 与现 Python **完全一致**；前端 `App.tsx` 不改。
- 官方背书 **验过才 stamp** `trust:'official'`；缺失/不匹配 fail-closed。
- 扫描/探测/支付类意图一律 fail-closed + 人审 + 已批权限；Node 不得自行放行。
- 验签/cosign/TUF 的规范化与 Ed25519 必须与 Python/clawhunt **逐字节一致**（金标向量门）。

## 7. 一致性策略（全 Node 验签的最大风险）

- **金标向量**：在 Python 侧写一个一次性导出脚本，dump 一批 `(input, JCS-bytes, keyid, envelope, verify-result)` 向量（覆盖 NFC/surrogate/排序/数字边界/阈值/坏签名），落 `tests/fixtures/trust-vectors.json`；Node 单测对每条逐字节/逐布尔命中。**这是「全 Node 重写含验签」可信的唯一硬证据。**
- **跨仓**：clawhunt 是签名侧，super(Node) 是验证侧，二者经同一向量集对拍，确保「Node 验得过 clawhunt 真签的产物」。
- **残留**：§4.6 技能编译工具链 subprocess；R2/ClawHunt 凭证经环境分档（dev/staging/prod），不入库。

## 8. 待业主进一步决策（实现阶段前）

- 委派缝已定为**全 Node 含验签**；导入/下载基座已定为**复用 Paperclip import 层（§3.5）**，落点 = 实例级根（`~/.paperclip/plugins/` + `~/.claude/skills/`），**无 companyId**（域调和叉已解决，不走 `companySkills`）。实现阶段需确认：① 金标向量导出脚本是否可一次性动用 Python 侧（仅生成 fixtures，不进运行时）；② 技能编译工具链（§4.6）用 `superclaw` 既有 ruff/mypy 还是独立 toolchain；③ Drizzle 新表（registry/cosign-cache/marketplace-saga/entitlement）schema 评审；④ 实例级 skills 根的**可写目标**：直接写 `~/.claude/skills/` 还是 super 专属子目录（避免与用户手装 skill 混淆），实现刀 4/7 前定。
