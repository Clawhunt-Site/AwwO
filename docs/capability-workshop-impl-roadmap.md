# 能力工坊实现路线图（Capability Workshop Implementation Roadmap）

> 本文是 [capability-workshop-roadmap.md](capability-workshop-roadmap.md) 的**代码级落地方案**：针对 SuperClaw 实际代码库，给出每个方向的新建/改动文件、字段级数据结构、CLI/API/契约签名、原子 PR 拆分（含验收标准与测试）、fail-closed 核对、迁移与开放问题。
>
> **方法**：5 路并行 agent 深读真实代码产出方案 → 汇总本文 → Codex(gpt-5.5)+Gemini 第二轮对抗验证（验证具体实现选择）→ 主代理裁决 → 定稿。评审裁决见 §7。
>
> **状态（2026-06-17）**：用户要求的 Capability Workshop 端到端闭环已集成到 `dev/roadmap`：ClawHunt admin 审核页 + submission/review/version/artifact/registry/audit 后端、SuperClaw plugin/skill/company 开发者 submit/status、审核通过后的 digest-pinned immutable artifact/registry、三类列表 registry 消费、同版本不可覆盖、撤销/替换留痕。2026-06-17 又补齐本地 production-distribution policy foundation：distribution decision 禁带生产私钥、签名动作必须引用隔离 signing authority、artifact/object ref 对外 opaque、同一 capability/version 不能被不同 digest 覆盖、publish/revoke/replace/sign 写 append-only audit。本次 Goal Go 追加集成了 `codex/capability-workshop-backend-api`、`codex/capability-workshop-devtools-cli`、`codex/capability-workshop-web-ui` 三个 worker 的 feature commits，并增加 `fix(capabilities): bridge workshop review API contract` 与 `test(capabilities): cover workshop local e2e`：本地 mock E2E 已覆盖开发者 plugin/skill/company 上传、管理员发布、digest-bound artifact 存储、download ref、registry sync，以及 devtool metadata review 不自动审批。随后补齐私有 Cloudflare R2 publication/pull：`publish-r2` 可把 approved registry 写入 `clawhunt-capability-registry-prod`、把 digest-addressed artifact 写入 `clawhunt-capability-artifacts-prod`，`r2://` registry source 可被 CLI 与 `/api/admin/capabilities/registry/sync` 消费，默认 official `capabilities.json` 已通过 plugin/skill/company smoke 验证。仍待的是未来生产硬化（hosted KMS/HSM、multipart/cloud object store 强化、签名 public registry 发布、支付/加密分发、真实 entitlement/auth）和面向 `main` 的 PR 提取，不阻断本闭环完成态。

---

## 0. 跨方向构建顺序（PR 级 DAG）

各方向 PR 用前缀编码：A=能力工坊 B=三来源/信任 C=自更新 D=提权 E=todo。**Web 表层一律最后；内核地基先行。** 三个高 ROI 早交付起点：A1（改名+三tab，纯表现层零风险）、E1+E2（live todo，80%已存在）、D1（提权 fail-closed 地基）。

```
P0 地基（可并行）
  ├─ A1  feat(web) 改名 插件市场→能力工坊 + 公司tab骨架        [纯表现层, 立即可发]
  ├─ A2  refactor(trust) 抽 SignedArtifactEnvelope+PackageTrustVerifier [纯重构,对拍护航]
  ├─ D1  feat(escalation) fail-closed人审门+durable store+加密票据+CLI   [提权地基]
  └─ E1  feat(core) 统一 task.* 事件 emission + seq via SSE id          [todo地基]

P1 信任与身份（依赖 A2）
  ├─ B1  feat(web) 用现有验证信息渲染信任徽章                 [早交付低风险表层]
  ├─ B2  refactor(kernel) verifier signer → 权威 TrustState 四态
  ├─ B3  feat(kernel) TUF元数据 + 反回滚watermark + freshness fail-closed
  └─ B4  feat(kernel) loader 命名空间保留 + 同id异签致命冲突

P2 目录与 Company 模板（依赖 A2/B2）
  ├─ A3  feat(catalog) superclaw-company.schema.json + CompanyTemplate + validate CLI
  ├─ A4  feat(catalog) CatalogUnion 只读发现(ui_contracts + catalog list CLI + /api/catalog)
  ├─ B5  feat(cli) CLI-backed catalog resolver + trust state 命令
  └─ B6  feat(api) /v1/catalog 包装同一 resolver + 回填 trust

P3 提权内核全量（依赖 D1）—— 方向三/五的人审确认都依赖它
  ├─ D2  feat(api) escalation REST inbox + SSE requested/resolved
  ├─ D3  feat(web) 通用弹窗(文本+N按钮) + pending 徽章
  ├─ D4  refactor 现有3套审批(governance/team/human-gate)迁入信封传输(授权不合并)
  └─ D5  feat(escalation) 归一化 Codex/Claude 原生 approval 回调

P4 todo 表层与契约（依赖 E1/D-plan）
  ├─ E2  feat(web) 单行增量 live update + 快照兜底
  ├─ E3  feat(cli) run-inspect tasks/plan --json 快照(事实源)
  ├─ E4  feat(api) GET /api/runs/{id}/tasks + /api/contracts/tasks 包装
  ├─ E5  feat(web) 消费 /api/contracts/tasks 杀硬编码枚举漂移
  ├─ E6  feat(core) 归一化 Claude TodoWrite / Codex plan → task.*（core adapter）
  └─ E7  feat(core) 内核拥有的 plan-only 非绑定大纲(延后/可剖出 P2 顺延)

P5 更新内核地基（依赖 C1）
  ├─ C2  feat(update) release manifest 验签 + 反回滚 watermark
  ├─ C3  feat(update) preflight 硬阻断(active run/审批/装插件/投影锁)
  ├─ C4  feat(state) PRAGMA user_version 迁移注册表 + 更新前备份 + min_reader_version
  └─ C5  feat(cli,api) version/update 命令+端点+ui_contracts 投影

P6 Web 表层收尾（最后）
  ├─ A5  feat(web) 公司 tab 接 /api/catalog?kind=company
  ├─ B7  feat(web) /v1/catalog live 目录 + TrustState 徽章 + 本地发现 + 冲突横幅
  └─ C6+ Settings 检查更新卡片 + Tauri updater 接线 + CI 签名公证（属表层, 后续）
```

> 注：C1（多维版本契约 + 签名 release manifest 格式，内核纯内部）可与 P0 并行起步，但其下游 C2-C5 排在 P5，因为依赖最重、用户可感最弱。

---


## 1. 方向一　能力工坊（三类资产共享信任、平行域模型）

**落地概述**：方向一 — 能力工坊（Capability Workshop）：三类资产共享信任原语（SignedArtifactEnvelope + PackageTrustVerifier）+ 平行强类型域模型（PluginPackage / SkillView / CompanyTemplate）+ 只读 CatalogUnion 发现层。本方向拥有方向二消费的共享信任地基。落地策略：先发"纯表现层改名+三tab骨架"PR（零内核风险），后台并行抽取信任原语（纯重构，行为零变化，由现有测试护航），再叠加 company schema + validate CLI。绝不把 company 塞成 plugin kind，绝不用 if kind=='company' 特例污染插件严格校验。


# 方向一 实施规格 — 能力工坊（Capability Workshop）

> 北极星核对：本规格严格遵守路线图 §0 五条护栏。**只把"签名信封 + 验证原语 + 目录展示"统一**；**安装/运行/授权/实例化/决策保持平行域模型**。任何 `if kind == 'company': skip_x()` 都被显式禁止。CLI 是唯一事实源，API/Web 只投影同一份核心逻辑。

---

## 0. 核心约束（来自真实代码的事实）

- 现有插件信任流水线在 `packages/superclaw/src/superclaw/plugins.py`：`verify_plugin_package`(plugins.py:107) 串起 `compute_package_digest`(plugins.py:93) → `validate_manifest_configuration_contract`(plugin_config.py:148) → `_verify_signature_with_trust`(plugins.py:326) → `_check_revocation`(plugins.py:362)，并写缓存。**这条流水线绝不能因为本方向改变行为。**
- 关键耦合点（提取时必须保通用化或保留）：
  - `compute_package_digest` 内对 `MANIFEST_NAME == "superclaw-plugin.json"` 硬编码（plugins.py:99）。
  - `_canonical_manifest_for_digest`(plugins.py:249) 假设 `manifest["provenance"]["package_digest"]` / `["signature"]` 必存在 —— 这是 digest 自指消解，company 信封必须复用同一 `provenance` 形状。
  - `_iter_package_files`(plugins.py:256) 拒绝 symlink、跳过 `__pycache__`/`.pyc`（company 包无 Python，但规则无害且必须保留以零行为变化）。
- 现有域模型：`CompanyProfile`(models.py:1223-1247) 是**纯本地 SQLite 治理命名空间**，字段 `name/company_profile_id/goal/owner_id/default_budget_seconds/default_token_budget/allowed_plugins/high_risk_policies/created_at/metadata`。**无清单/无签名/无模板** —— 路线图 §1 已核实。`CompanyTemplate` 是它的**可分发蓝图**，不替换它。
- 实例化目标对接：`team_kernel.update_agent_profile`(team_kernel.py:244) + `EDITABLE_PROFILE_FIELDS`(team_kernel.py:192) 是 P1 commit 阶段写角色配置的落点；`resolve_equipment`(team_kernel.py:128) 是 equipment_requirements 的 fail-closed 交集裁决点。**P0 本规格不触发实例化，只做 validate。**
- CLI 用 Typer：`company_app`(cli.py:199)、`plugin_app`(cli.py:189) 已注册（cli.py:212/220）；`_emit_json`(cli.py:4038)、`_team_store`(cli.py:4034)、`_fail`(cli.py:4042) 是统一输出/存储/失败原语。
- API 用 FastAPI 闭包工厂，端点是 core builder 的薄包装：`plugin_status`(main.py:2676) → `build_plugin_status_payload`(ui_contracts.py:357)；`require_control_token` 是统一鉴权 Depends。
- Web `App.tsx`：`workspaceSurface` 联合类型在 App.tsx:3228（`'chat'|'control'|'cockpit'|'plugins'|'fusion'|'team'`）；tab 状态 `pluginStoreTab`(App.tsx:3221, `'plugins'|'skills'`)；shell 在 App.tsx:9702-9704；tab 按钮 App.tsx:9707-9724；i18n "插件市场" 散落在 1905/1925/1933/2009/2427/2512 等，标签键 `Plugin catalog tab plugins/skills`(2105/2106/2466/2467)、`pluginsMarketplace`(1925)、`pluginTitle`(1905/2009)、`Marketplace catalog`(2103/2464)。`PluginCatalogItem.source`(App.tsx:1636) = `'mock'|'registry'|'server'|'local'`。

---

## 1. 新建模块/文件

### 1.1 `packages/superclaw/src/superclaw/trust.py`（共享信任原语 —— 唯一被三类资产共享的东西）

职责：把 `plugins.py` 里**与 plugin 域无关**的"信封解析 + digest + 签名 + 吊销"逻辑无损上移成域无关原语。**plugins.py 改为调用它，行为字节级不变。**

```python
# trust.py
MANIFEST_DIGEST_FIELDS = ("package_digest", "signature")  # under provenance

class ArtifactTrustError(ValueError):
    """Domain-agnostic trust verification failure (parent of PluginVerificationError)."""

@dataclass(frozen=True)
class SignedArtifactEnvelope:
    """The common signed manifest header shared by every capability kind.
    Parsed from a manifest dict; carries ONLY the fields the trust pipeline needs
    (identity + provenance) plus a passthrough to the full manifest. It is the
    transport/signature layer — it knows nothing about runtime/tools/roles."""
    kind: str                 # "plugin" | "company"  (skill is a plugin projection, not a kind here)
    artifact_id: str          # manifest["id"]
    version: str
    schema_version: str
    manifest_name: str        # "superclaw-plugin.json" | "superclaw-company.json"
    package_digest: str       # manifest["provenance"]["package_digest"]
    signature: str            # manifest["provenance"]["signature"]
    source_type: str | None   # manifest["source"]["type"] — SELF-DECLARED, never a trust fact
    manifest: dict[str, Any]
    @property
    def identity(self) -> str:
        # §0 护栏5: identity = kind:id:version:digest, NOT display name
        return f"{self.kind}:{self.artifact_id}:{self.version}:{self.package_digest}"
    @classmethod
    def from_manifest(cls, manifest, *, kind, manifest_name) -> "SignedArtifactEnvelope": ...

def canonical_manifest_for_digest(manifest, *, digest_fields=MANIFEST_DIGEST_FIELDS) -> bytes:
    """Move of plugins._canonical_manifest_for_digest, generalized over which
    provenance fields are blanked. Default == current plugin behavior."""
def compute_artifact_digest(root: Path, *, manifest, manifest_name: str) -> str:
    """Move of plugins.compute_package_digest, parameterized on manifest_name.
    Identical bytes for plugin packages (manifest_name='superclaw-plugin.json')."""
def iter_artifact_files(root: Path) -> list[Path]:
    """Move of plugins._iter_package_files (symlink reject + pycache skip)."""
def verify_signature_with_trust(digest, signature, public_key) -> str:
    """Move of plugins._verify_signature_with_trust. Returns 'official'|'local_dev'.
    Reads SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY + local_dev_trust_enabled() EXACTLY as today."""
def check_revocation(*, artifact_id, version, package_digest, revocation_file: Path) -> None:
    """Move of plugins._check_revocation, taking primitive args so company reuses it."""

class PackageTrustVerifier:
    """parse → digest → signature → revocation, as a reusable object.
    Does NOT do domain validation (configuration contract / roles / runtime)
    — that stays in each domain's loader. This is the §0 护栏1 boundary."""
    def __init__(self, *, public_key=None, revocation_file=None, manifest_name: str, kind: str): ...
    def verify_root(self, root: Path) -> tuple[SignedArtifactEnvelope, str]:
        """Returns (envelope, trust_class). Raises ArtifactTrustError on any
        digest/signature/revocation failure (fail-closed)."""
```

**关键设计**：`TrustState` 枚举**不在本 PR**（属方向二 P1）。trust.py 只产 `trust_class ∈ {"official","local_dev"}`（与今天 `_verify_signature_with_trust` 返回值一致）+ 抛错=untrusted。方向二在此之上派生 4 态 `TrustState`。

### 1.2 `packages/superclaw/src/superclaw/company_template.py`（company 域模型 + registry，平行于 PluginPackage）

职责：company 模板的加载/校验/registry，**完全独立于 plugins.py**。复用 trust.py 做信任，复用 company 自己的 schema 做域校验。

```python
# company_template.py
MANIFEST_NAME = "superclaw-company.json"
DEFAULT_COMPANY_CACHE = Path(".superclaw/companies/cache")
DEFAULT_COMPANY_REVOCATION_FILE = Path(".superclaw/companies/revocations.json")

class CompanyTemplateError(ValueError): ...

@dataclass(frozen=True)
class CompanyTemplate:
    source: Path; root: Path; manifest: dict; temporary_root: Path | None = None
    @property
    def template_id(self) -> str: ...
    @property
    def version(self) -> str: ...
    @property
    def roles(self) -> list[dict]: ...                  # manifest["roles"]
    @property
    def equipment_requirements(self) -> dict: ...        # per-role plugin/skill allowlist
    def cleanup(self) -> None: ...

def load_company_template(path: Path) -> CompanyTemplate:
    """Mirror of plugins.load_plugin_package: dir or .sccompany zip, safe-extract
    (reuse trust.iter_artifact_files symlink rules)."""
def validate_company_template_schema(manifest: dict) -> None:
    """JSON-Schema validate against schemas/superclaw-company.schema.json + cross-field
    invariants (§3.2): equipment_requirements role key must ∈ roles[]; budgets ≥ 0;
    policy risk levels in enum."""
def validate_company_template(path, *, public_key=None, revocation_file=None) -> "CompanyTemplateVerification":
    """P0 ENTRY POINT. parse → schema → digest → signature → revocation, via
    PackageTrustVerifier(kind='company', manifest_name=MANIFEST_NAME). NEVER instantiates."""

@dataclass(frozen=True)
class CompanyTemplateVerification:
    template_id: str; version: str; digest: str; trust_class: str
    role_count: int; equipment_requirement_count: int

def list_cached_company_templates(*, cache_root=None) -> list[dict]:
    """Mirror of plugins.list_cached_plugins: scan */*/superclaw-company.json."""
def list_registry_company_templates(cloud_root: Path) -> list[dict]:
    """Mirror of plugin_cloud.list_registry_plugins, scanning
    cloud_root/registry/companies/*/*/metadata.json (parallel registry layout,
    NOT a plugin kind in the same tree)."""
```

### 1.3 `schemas/superclaw-company.schema.json`（见 §3.2 全字段定义）

### 1.4 测试 fixtures：`tests/fixtures/companies/<id>/<version>/superclaw-company.json`（最小有效 company 模板）

---

## 2. 改动的现有文件（保行为；标 back-compat）

### 2.1 `plugins.py` —— 纯重构为调用 trust.py（**行为零变化**）

| 锚点 | 改动 | back-compat |
|---|---|---|
| plugins.py:93 `compute_package_digest` | `return trust.compute_artifact_digest(package.root, manifest=package.manifest, manifest_name=MANIFEST_NAME)` | 公开签名不变；返回值字节级一致 |
| plugins.py:249 `_canonical_manifest_for_digest` | 删本体，内部由 `trust.canonical_manifest_for_digest` 承接（或保 1 行 wrapper） | grep 确认仅内部引用 |
| plugins.py:256 `_iter_package_files` | 委托 `trust.iter_artifact_files`；保同名 wrapper | symlink/pycache 规则不改 |
| plugins.py:326 `_verify_signature_with_trust` | 委托 `trust.verify_signature_with_trust`；保同名 wrapper | env 名 `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` 不变 |
| plugins.py:362 `_check_revocation` | 委托 `trust.check_revocation`，把 `package` 拆成 primitive args；保同名 wrapper | 吊销匹配语义不变 |
| plugins.py:26 `PluginVerificationError` | `class PluginVerificationError(trust.ArtifactTrustError)`（仍 ValueError 子类） | `except ValueError`/`except PluginVerificationError` 均继续命中 |

**铁律**：`verify_plugin_package`(plugins.py:107) 调用顺序与异常类型不动：digest→config-contract→signature→revocation→cache。manifest 配置契约校验（plugin_config.py:148）**留在 plugins.py**，不进 trust.py（plugin 域专属，正是 §0 护栏1 要隔离的"域校验"）。

### 2.2 `ui_contracts.py` —— 新增 `build_catalog_union_payload`（§3.3 + §6）
- import：`from superclaw.company_template import list_cached_company_templates, list_registry_company_templates`。
- 新增函数（紧随 `build_plugin_status_payload` 后，约 ui_contracts.py:443 之后）。
- 复用 `list_cached_plugins`(plugins.py:182)、`list_registry_plugins`(plugin_cloud.py:82)、`is_skill_origin_plugin`(plugins.py:170) 投影 skill 视图，**不新写枚举**。

### 2.3 `cli.py` —— 新增 catalog_app + company template 子命令（§4）
- `catalog_app = typer.Typer(...)`（约 cli.py:201 邻接）；`app.add_typer(catalog_app, name="catalog")`（约 cli.py:222）。
- `company_template_app = typer.Typer(...)`；`company_app.add_typer(company_template_app, name="template")`。

### 2.4 `apps/api/main.py` —— 新增 catalog 端点（薄包装；§5）
- import 追加 `build_catalog_union_payload`（main.py:155 import 块）。
- `@app.get("/api/catalog")` + `@app.post("/api/companies/template/validate")` + `@app.get("/api/contracts/catalog-union")`。

### 2.5 `apps/web/src/App.tsx` —— 改名 + 公司 tab 骨架（A1 纯表现层）

---

## 3. 数据结构 / Schema

### 3.1 `SignedArtifactEnvelope`（§1.1）
不变量：`package_digest` 匹配 `^sha256:[a-f0-9]{64}$`；`signature` 匹配 `^ed25519:.+`；`identity` 永远 `kind:id:version:digest`；`source_type` 只是自述、**绝不**参与信任推导（§0 护栏2）。

### 3.2 `schemas/superclaw-company.schema.json`（JSON Schema 2020-12，镜像插件信封）
顶层 `required`: `["schema_version","id","name","version","summary","source","roles","provenance"]`，`additionalProperties:false`。

| 字段 | 类型 | 不变量 |
|---|---|---|
| `schema_version` | semver | 复用插件 schema `$defs/semver` |
| `id` | string | `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$`（同 pattern，但**命名空间独立**：company id 进 company registry，永不与 plugin id 同冲突域比较） |
| `name` | string | minLength 1（display only） |
| `version` | semver | |
| `summary` | string | 1..240 |
| `logo` | string | 同插件 `logo` pattern |
| `source` | object | `required:["type","developer_id","clawhunt_problem_id"]`；`type ∈ {"developer_upload","clawhunt_delivery","first_party"}`（镜像 plugin schema:39-57，自述） |
| `roles` | array(minItems 1) | 每项 `{role_key,name,charter,title?,reports_to?,persona?,default_instructions?}`；`role_key` `^[a-z][a-z0-9_]*$` uniqueItems |
| `equipment_requirements` | object | key=`role_key`（**必须 ∈ roles[].role_key**），value=`{plugins:[id...],skills:[id...]}` |
| `policies` | object | `{high_risk_policies:{...}}`，镜像 `CompanyProfile.high_risk_policies`；risk_level ∈ `{low,medium,high,critical}` |
| `budgets` | object | `{default_budget_seconds:int≥0, default_token_budget:int≥0}`（镜像 CompanyProfile） |
| `commerce` | object（可选） | **复用插件 commerce enum**（plugin schema:243-253） |
| `acceptance` | object（可选） | `{level: L1|L2|L3}`（轻量版，无 tests/fixtures 硬要求；与插件 acceptance 区分以免域污染） |
| `provenance` | object | `required:["build_type","package_digest","signature"]`；digest `^sha256:[a-f0-9]{64}$`；signature `^ed25519:.+`；source_digest 可空。**与插件 provenance 同形状**，使 `canonical_manifest_for_digest` 可零参复用 |

cross-field 不变量（在 `validate_company_template_schema`，schema 之外补强）：
1. `equipment_requirements` 每 role_key ∈ roles → 否则 `CompanyTemplateError`。
2. `reports_to` 非空必须 ∈ role_keys（acyclic 检查留 P1，P0 不实例化）。
3. 不在 schema 阶段解析 plugin/skill 是否真实可用 —— 那是 commit 阶段 `resolve_equipment` 的 fail-closed 交集。

### 3.3 `CatalogUnion` 契约（只读发现）
TS（App.tsx 新增，扩展 `PluginCatalogItem`）：
```ts
type CatalogKind = 'plugin' | 'skill' | 'company';
type CatalogItem = {
  kind: CatalogKind; id: string; version: string;
  name: string; summary?: string;
  source: 'mock'|'registry'|'server'|'local';  // 复用 PluginCatalogItem.source(App.tsx:1636)
  verified: boolean;                            // 已验证信息, P0 不重算 TrustState
  role_count?: number;                          // company-only
};
type CatalogUnion = {
  kind_filter: CatalogKind | null;
  plugins: CatalogItem[]; skills: CatalogItem[]; companies: CatalogItem[];
  notice: 'discovery_only';                     // §0 护栏3: 声明存在+可发现, 绝不声明可运行/已授权
};
```
core 侧 `build_catalog_union_payload` 返回同形 dict。**company tab P0 只读列举本地+registry，无 install 按钮**（install/instantiate 是 P1，走 proposal）。

---

## 4. CLI 命令（CLI 是事实源）

### 4.1 `superclaw catalog list [--kind plugin|skill|company] [--json]`
- 包装 `build_catalog_union_payload(kind=..., cache_root=_plugin_cache_path(), cloud_root=...)`；`--json` 输出 `CatalogUnion`；无 `--kind` 三类全列；非 JSON 分组打印 `kind id@version (source, verified)`。

### 4.2 `superclaw company template validate <path> [--public-key KEY] [--json]`（**P0 仅 validate**）
- 调 `company_template.validate_company_template(path, public_key=...)`。成功 JSON：
```json
{"ok": true, "kind": "company", "identity": "company:<id>:<ver>:<digest>",
 "template_id": "<id>", "version": "<ver>", "digest": "sha256:...",
 "trust_class": "official|local_dev", "role_count": N, "equipment_requirement_count": M}
```
- 失败：`{"ok": false, "error": "<msg>"}` + `raise typer.Exit(1)`（fail-closed）。
- **P1（不在本规格）**：`company template export/import/instantiate` + `team bootstrap --from-template <id> --mode proposal|commit`。

---

## 5. API 端点（薄包装同一 core，无并行实现）

### 5.1 `GET /api/catalog?kind=plugin|skill|company`
```python
@app.get("/api/catalog")
def catalog_union(kind: str | None = None, _: None = Depends(require_control_token)) -> dict[str, Any]:
    return build_catalog_union_payload(kind=kind, cache_root=_plugin_cache_path_api(), cloud_root=_cloud_root_api())
```
响应 = §3.3。与 CLI `catalog list` 调同一 core builder。

### 5.2 `POST /api/companies/template/validate`
请求体 `{"path":"<abs path>", "public_key"?:"..."}`（path 必须在受信任工作区内，复用现有路径安全门）。响应 = §4.2 JSON。内部直调 `validate_company_template`，**与 CLI 同一函数**。

### 5.3 `GET /api/contracts/catalog-union` → 投影 `CATALOG_UNION_SPEC`（同 `build_skill_sync_contract` 端点模式 main.py:2903）。

---

## 6. `ui_contracts.py` 新增（共享契约，防止表层硬编码）
- `CATALOG_UNION_SPEC: dict` 常量：三 kind 展示字段、`source` 徽章枚举（`["mock","registry","server","local"]` 与 App.tsx:1636 一致）、`discovery_only` 语义、冲突规则占位（`"hard_conflict_on_same_id_different_signer"` —— 方向二接管实现，本规格只锁契约文字）。
- `build_catalog_union_payload(...)`：组装 plugins + skills（`is_skill_origin_plugin` 过滤同一插件集）+ companies，打 `kind` 标签，附 `notice`。

---

## 7. 原子 PR 拆分
（见 pr_breakdown；A1 改名先行纯表现层，A2 纯重构有测试护航，A3/A4 地基，A5 收口。每个 PR 仍须按 CLAUDE.md 铁律走 Codex+Gemini 验收门。）

---

## 8. fail-closed / 治理红线核对
1. **域污染零容忍（§0 护栏1）**：company 走 `company_template.py` 独立 schema + 独立 registry(`registry/companies/`) + 独立 cache(`.superclaw/companies/cache`) + 独立 revocation。plugins.py 的 `validate_manifest_configuration_contract` **不被 company 调用**，trust.py **不含**任何 `if kind=='company'` 分支。
2. **信任由验证推导（§0 护栏2）**：`source.type` 只读不信；`trust_class` 来自 `verify_signature_with_trust`。本 PR 不发 official 徽章——那是方向二 `TrustState` 的活，A5 的 `verified` 只反映"签名通过"。
3. **P0 不实例化（§0 护栏3）**：`company template validate` 绝不写权限/预算/设备。实例化（proposal→人审 dropped equipment/high-risk→commit）是 P1，且 commit 经 `resolve_equipment`(team_kernel.py:128) fail-closed 交集 + `update_agent_profile`(team_kernel.py:244) 的 permission_mode/reports_to 门——模板永不能 widen 治理。
4. **fail-closed 默认（§0 护栏4）**：validate 任一环节失败（坏 schema / digest 不符 / 签名无效 / 吊销 / 无 public key）→ 抛错 + CLI 退 1 + API 4xx。catalog 即便列出某 company，也只声明 `discovery_only`，不授权运行。
5. **表层零新增语义（§0 护栏3）**：`/api/catalog`、`/api/companies/template/validate` 都是 core 薄包装；Web 不自算信任/冲突/可运行性。

---

## 9. back-compat / 迁移
- **plugin 流水线**：A2 纯重构，公开符号/异常类型/env 名/digest 算法不变；现有 26+ 引用 `verify_plugin_package`/`compute_package_digest` 的测试与调用方零改动（已核实 `tests/test_plugin_local_verification.py` 直接 import 这些符号）。
- **CompanyProfile 不动**：`CompanyProfile`(models.py:1223) 及 `from_dict`/`to_dict`、`company init`(cli.py:4386)、`company list/show` 全保留。`CompanyTemplate` 是新增的可分发蓝图，与运行态 `CompanyProfile` 是"模板 vs 实例"关系，P0 二者无耦合。
- **Web**：A1 只换文案 + 加 tab，`workspaceSurface==='plugins'` 路由不变；plugins/skills tab 行为零变化；`PluginCatalogItem` 类型向后兼容（`CatalogItem` 是其超集）。
- **新增目录**：`.superclaw/companies/{cache,revocations.json}`、`registry/companies/` 首次使用时创建，缺失即空列表（fail-soft，与 `list_cached_plugins` 一致）。

---

## 10. 给对抗式评审的具体压测点
见 open_questions。


### 原子 PR 拆分（汇总表）

| PR | 范围 | 验收标准 | 依赖 |
|---|---|---|---|
| feat(web): rename 插件市场→能力工坊 and add 公司 tab skeleton | apps/web/src/App.tsx — replace all user-visible '插件市场'/'Plugin marketplace' strings with '能力工坊'/'Capability Workshop' at i18n anchors (en ~1905 pluginTitle, 1916 pluginsSubtitle; zh ~1925 pluginsMarketplace, 1933 openPluginMarketplace, 2009 pluginTitle, 2020 pluginsSubtitle, 2427 'Open marketplace', 2512 'Plugin marketplace detail', plus 2103/2464 'Marketplace catalog'); extend pluginStoreTab union (App.tsx:3221) to include 'companies' and add a third 公司 tab button next to App.tsx:9707-9724 with new i18n key 'Plugin catalog tab companies' (2105/2466 region); render a placeholder/empty company panel; keep workspaceSurface==='plugins' routing unchanged. Add apps/web/tests/catalog-rename.test.tsx and apps/web/tests/company-tab-skeleton.test.tsx. | Three tabs (插件/技能/公司) render and switch; grep finds no remaining user-visible '插件市场' string in either en or zh dictionary; company tab shows a coming-soon placeholder and calls no unimplemented API; npm run build --prefix apps/web passes; existing plugins/skills tab behavior unchanged. |  |
| refactor(trust): extract SignedArtifactEnvelope + PackageTrustVerifier from plugins.py | new packages/superclaw/src/superclaw/trust.py (SignedArtifactEnvelope, ArtifactTrustError, canonical_manifest_for_digest, compute_artifact_digest, iter_artifact_files, verify_signature_with_trust, check_revocation, PackageTrustVerifier); edit plugins.py to delegate compute_package_digest(:93), _canonical_manifest_for_digest(:249), _iter_package_files(:256), _verify_signature_with_trust(:326), _check_revocation(:362) and reparent PluginVerificationError(:26) under ArtifactTrustError — ZERO behavior change. Add tests/test_trust_envelope.py and tests/test_plugin_refactor_parity.py. | tests/test_plugin_local_verification.py passes UNCHANGED; compute_package_digest returns byte-identical digest for the same package versus a pre-refactor golden (parity test, run with PYTHONDONTWRITEBYTECODE=1 to avoid pyc mtime trap); PluginVerificationError isinstance of both ValueError and ArtifactTrustError; verify pipeline order (digest→config-contract→signature→revocation→cache) preserved; verify_plugin_integrity still does not query revocation and check_plugin_revocation still queries it per call. | can run in parallel with the rename PR |
| feat(catalog): superclaw-company.schema.json + CompanyTemplate domain model + validate CLI | new schemas/superclaw-company.schema.json (fields per spec §3.2, mirrors plugin envelope provenance/source/commerce + roles[]/equipment_requirements/policies/budgets, additionalProperties:false); new packages/superclaw/src/superclaw/company_template.py (CompanyTemplate, CompanyTemplateError, load_company_template, validate_company_template_schema, validate_company_template using trust.PackageTrustVerifier(kind='company'), list_cached_company_templates, list_registry_company_templates); new tests/fixtures/companies/*; edit cli.py to add company_template_app under company_app with 'template validate <path>' command (P0 validate only). Add tests/test_company_template.py and tests/test_company_template_cli.py. | superclaw company template validate <good> --json returns ok+identity (company:id:ver:digest)+trust_class+role_count; bad schema, bad signature, and revoked template each fail-closed (exit 1, {ok:false}); company uses its OWN .superclaw/companies/{cache,revocations.json} and registry/companies/, never the plugin tree; cross-field invariant (equipment_requirements role_key ∈ roles[]) enforced; missing public key fails closed identically to the plugin path. | extract SignedArtifactEnvelope/PackageTrustVerifier PR |
| feat(catalog): CatalogUnion read-only discovery (ui_contracts + catalog list CLI + /api/catalog) | edit ui_contracts.py to add CATALOG_UNION_SPEC and build_catalog_union_payload(kind, cache_root, cloud_root) reusing list_cached_plugins/list_registry_plugins/is_skill_origin_plugin + list_cached_company_templates/list_registry_company_templates; edit cli.py to add catalog_app ('catalog list --kind --json') and register via app.add_typer; edit apps/api/main.py to add GET /api/catalog, GET /api/contracts/catalog-union (thin wrappers over the core builder). Add tests/test_catalog_union.py, tests/test_catalog_cli.py, tests/test_catalog_api.py. | superclaw catalog list --json aggregates plugin/skill/company tagged by kind; --kind company returns only companies; payload carries notice='discovery_only' and NO install/run/entitlement fields; /api/catalog returns the same shape as the CLI (asserted); contracts endpoint projects CATALOG_UNION_SPEC so surfaces read badge enums instead of hardcoding. | CompanyTemplate domain model PR |
| feat(web): wire 能力工坊 公司 tab to /api/catalog?kind=company | edit apps/web/src/App.tsx — company tab fetches /api/catalog?kind=company, renders CatalogItem rows, reads the source-badge enum from /api/contracts/catalog-union (no hardcode), and exposes NO install/instantiate action (P0 discovery only). Add apps/web/tests/company-catalog.test.tsx. | Company tab lists local + registry templates; badges sourced from the shared contract not hardcoded; no run/authorize controls present; web build + apps/web/tests/company-catalog.test.tsx pass. | CatalogUnion discovery PR |



### 待评审的开放问题

- A2 digest 对拍：compute_artifact_digest 是否与旧 compute_package_digest 字节级一致（canonical_manifest_for_digest 的置空顺序/sort_keys/separators/MANIFEST_NAME 硬编码）？manifest 无 provenance 时旧代码 KeyError 而新代码静默——是否引入行为漂移？
- trust.py 是否偷渡域逻辑：PackageTrustVerifier.verify_root 必须只做 digest+signature+revocation，绝不能把 plugin 的 validate_manifest_configuration_contract 并进来（否则 company 走插件域校验=路线图 §0 护栏1 明令禁止的域污染）。
- company id 与 plugin id 同 pattern 但应在不同冲突域：catalog union / revocation 查询是否存在任何路径把 company:foo 与 plugin:foo 当同一身份比较，埋下方向二要防的 namespace 劫持隐患？
- fail-closed 对齐：validate_company_template 在 public_key 缺失/local_dev 场景的放行/拒绝行为是否与插件 _verify_signature_with_trust(plugins.py:326-348) 完全一致？local_dev_trust env 是否被 company 误共享/误放行？
- 重构破坏面：把 _check_revocation 改成接受 primitive args 后，verify_plugin_integrity(:138) 与 check_plugin_revocation(:156) 的‘integrity 不查 revocation、每次 use 单独查 revocation’语义（mid-run revocation 仍生效）是否被破坏？
- schema 镜像 vs 域污染边界：company schema 复用插件 commerce/provenance/semver 是合法的‘信封统一’还是越界的‘语义统一’？company 的 acceptance 去掉 tests/evidence_fixtures 是否会在某处复用插件 acceptance 校验时崩？
- CatalogUnion 是否泄露授权语义：payload 是否真无 install/run/entitlement 字段？Web A5 是否可能从 verified:true 推出‘可运行’而绕过 entitlement/policy？notice='discovery_only' 是否在每条路径都成立？

### 已识别风险

- A2 是高杠杆纯重构：plugins.py 信任流水线被 26+ 测试/调用方依赖，任何 digest 算法、异常类型、调用顺序的细微漂移都会静默削弱插件安全校验（路线图点名的最大单点风险）。必须用‘重构前后对拍 + 干净进程（PYTHONDONTWRITEBYTECODE=1 避 pyc mtime 陷阱）’验证。
- schema 镜像把握不好会从‘统一信封’滑成‘统一语义’：company schema 若过度复用插件 acceptance/runtime 字段，等于把 company 拖进插件域校验，触发顾问已判不通过的域污染。必须严格只镜像 provenance/source/commerce/semver 信封层。
- company 与 plugin 的 registry/cache/revocation 目录与身份命名空间必须物理隔离；任何共享都会给方向二的 namespace 硬隔离埋雷。
- CatalogUnion 只读发现层若被 Web 误读为‘可运行/已授权’（例如把 verified 当 install 许可），就会让 fail-closed 沦为 UI 口号——必须在 payload 和契约里显式 discovery_only 且无任何 install/run 字段。
- P0 严守 validate-only：一旦 company template 在本阶段触碰实例化（写权限/预算/设备），就绕过了 resolve_equipment 的 fail-closed 交集与人审门。实例化必须留到 P1 的 proposal→commit 路径。
- i18n 改名（A1）若漏改某处用户可见‘插件市场’串，会造成文案不一致；需 grep 全量核对 en+zh 两套词典并加测试断言。


---


## 2. 方向二　官方/开发者/本地 三来源 + 热更新名单（TUF 风格）

**落地概述**：方向二 — 官方/开发者/本地 三来源 + 热更新名单 (TUF-style). 在 Direction 1 已定义的 PackageTrustVerifier/SignedArtifactEnvelope 之上，新增一个 CLI-as-source-of-truth 的 catalog resolver + TrustState 推导层 + TUF 风格热更新元数据 (.superclaw/registry/)，并在 loader 处硬写入命名空间保留与同名异签致命冲突。所有徽章由"验证结果"推导，绝不信 manifest.source；/v1/catalog 与 Web 徽章只投影同一份 CLI/core 结果。


# 方向二实现规格：官方 / 开发者 / 本地 三来源 + 热更新名单（TUF-style）

> 本规格 **消费** Direction 1 已定义的 `SignedArtifactEnvelope` + `PackageTrustVerifier`（假设其已存在于 `packages/superclaw/src/superclaw/package_trust.py`，封装现有 `plugins.py` 的 digest 重算 / Ed25519 验签 / revocation 逻辑），在其之上建 **信任名单 / 目录解析 / TrustState 推导 / 命名空间硬隔离**。不重复 spec D1 的验签原语。

---

## 0. 关键地基事实（file:line 核实）

- `manifest.source.type` 与 `provenance.build_type` 都含枚举 `first_party`（`schemas/superclaw-plugin.schema.json` source.type 与 provenance.build_type）。**路线图护栏 2 明令**：TrustState 不得由 `manifest.source` 推导（那是包自述）。所以 `first_party` 字段只能用于"声明候选"，真正的 `official` 必须由 **根公钥验签 + 命名空间归属** 推导。
- 现有验签返回的"信任类"已存在雏形：`plugins.py:326 _verify_signature_with_trust()` 返回 `"official"`（根公钥验签通过）或 `"local_dev"`（`SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST` 开 + 官方验签失败）。**但这个返回值当前被丢弃**（`verify_plugin_package` 不向上传它，`plugins.py:125` 调用处忽略返回值）。Direction 2 要把这个信任类一路提升为权威 `TrustState`。
- `plugins.py:362 _check_revocation()` 读 **明文未签名** `revocations.json`，无 sequence、无 freshness。这是 TUF timestamp/snapshot 要补的洞。
- 缓存发现：`plugins.py:182 list_cached_plugins()`（`.superclaw/plugins/cache/{id}/{version}`）。
- fail-closed 枚举门：`plugin_runtime_projection.py:72 gate_passing_plugins()` / `:125 available_plugins()`，共享 `_gate_passes`（`:_gate_passes` via `verify_cached_package_before_execution`→`plugin_proxy.py:312`）。**命名空间硬隔离与同名异签冲突必须挂在这条门里**，否则枚举与运行授权会漂移。
- 注册表读模型：`plugin_cloud.py:82 list_registry_plugins()`（`.superclaw/plugins/cloud/registry/plugins/*/*/metadata.json`），`:365 _sanitize_registry_metadata()` 已吐出 `verified`/`package_digest`/`signature`/`acceptance_level`。
- API：`/v1/plugins`(main.py:4713)、`/v1/skills`(4734)、`/api/plugins/marketplace-catalog`(2731)、`/v1/entitlements/sync`(4767)、`/v1/plugins/revocations`(4776) 都已存在，**每个都直接调 `plugin_cloud` 函数**（无 CLI 间接层）。Direction 2 引入 `catalog_resolver`，让 `/v1/catalog` 与 CLI **包同一个 resolver**。
- Web：`PluginCatalogItem.source: 'mock'|'registry'|'server'|'local'`（App.tsx:1636）；徽章 `selectedRegistryPlugin?.verified`（10314）；`pluginCatalogSourceLabel`（4900）；registry→catalog 映射在 `useMemo` 3727-3745，**此处 `source: 'registry'` 是硬编码**，未带 TrustState。
- Typer CLI：`plugin_app`(cli.py:189)、`company_app`(199)；命令模式统一 `--json` → `typer.echo(json.dumps(payload, ensure_ascii=False))`（如 `plugin_verify` cli.py:2124-2135）。

---

## 1. TrustState 推导（由验证推导，不信 manifest.source）

### 1.1 新建模块 `packages/superclaw/src/superclaw/trust_state.py`

职责：把 `PackageTrustVerifier` 的结果 + 命名空间归属 + 委托名单 + revocation/freshness 合成单一权威 `TrustState`。**唯一可以判定 official/developer/local/untrusted 的地方**。

```python
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum

FIRST_PARTY_NAMESPACES: tuple[str, ...] = ("superclaw.", "first_party.")  # 写死，见 §3

class TrustState(str, Enum):
    OFFICIAL = "official"       # 根公钥验签 + id 在保留命名段内
    DEVELOPER = "developer"     # 已注册开发者公钥(在 delegated targets 内)验签 + 未吊销 + freshness 新鲜
    LOCAL = "local"            # local_dev_trust 或本地构建(无可验证根/委托签名),且 id 不在保留命名段
    UNTRUSTED = "untrusted"     # 任意验签失败/吊销/freshness 过期(高危)/命名空间劫持

@dataclass(frozen=True)
class TrustDerivation:
    state: TrustState
    signer_class: str            # "root" | "developer:<keyid>" | "local_dev" | "none"
    namespace_reserved: bool     # id 落在 FIRST_PARTY_NAMESPACES?
    revoked: bool
    freshness_ok: bool           # timestamp 元数据是否新鲜(高危操作需 True)
    rollback_ok: bool            # sequence >= 本地水位?
    reasons: tuple[str, ...]     # 人读诊断("namespace_hijack","sig_invalid","timestamp_expired",...)

def derive_trust_state(
    *,
    plugin_id: str,
    verifier_verdict: "PackageTrustVerdict",   # 来自 Direction 1 PackageTrustVerifier
    registry: "TrustRegistry",                 # §2 加载的 TUF 名单(role/targets/snapshot/timestamp)
    revoked: bool,
    high_risk: bool,                           # commerce 含支付/permissions 含 network probe 等
    now: float,
) -> TrustDerivation: ...
```

**判定规则（fail-closed，按顺序短路到 UNTRUSTED）**：

1. `revoked` → `UNTRUSTED`（reason `revoked`）。
2. 命名空间归属：`namespace_reserved = any(plugin_id.startswith(p) for p in FIRST_PARTY_NAMESPACES)`。
   - 若 `namespace_reserved` 且 `verifier_verdict.signer_class != "root"` → `UNTRUSTED`（reason `namespace_hijack`）。这是 §3 命名空间劫持的内核拦截点之一（loader 处 §3.2 再致命异常一次，纵深）。
3. signer 分类：
   - `signer_class == "root"` 且 `namespace_reserved` → `OFFICIAL`。
   - `signer_class == "root"` 但 **非** 保留命名段 → 仍允许 `OFFICIAL`（根可签任意 id；但保留段反向独占，见 §3）。决策：保守取 `OFFICIAL`，因为根私钥即官方背书。
   - `signer_class.startswith("developer:")` → 校验该 keyid 在 `registry.delegated_targets` 内且 active：
     - `high_risk` 且 `not freshness_ok` → `UNTRUSTED`（reason `developer_freshness_stale`，fail-closed，§2.4 等价 CRL 新鲜度）。
     - 否则 `DEVELOPER`。
   - `signer_class == "local_dev"`（`SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST` 开）→ 若 `namespace_reserved` → `UNTRUSTED`；否则 `LOCAL`。
   - 其余（验签失败 / 无 key）→ `UNTRUSTED`。
4. anti-rollback：`rollback_ok = snapshot.sequence >= watermark`；`high_risk and not rollback_ok` → 降 `UNTRUSTED`（reason `sequence_rollback`）。

**不变式**：`OFFICIAL/DEVELOPER` ⟹ `verifier_verdict.integrity_ok and not revoked`。任何一项不成立必为 `UNTRUSTED`。`LOCAL` 永不命中保留命名段。**纯函数，无 I/O**（registry/verdict 由调用方注入），便于单测穷举状态机。

### 1.2 数据结构（field-level）

```python
@dataclass(frozen=True)
class CatalogItem:                 # 目录联合层的单条可发现条目(只读发现,不授权运行)
    kind: str                      # "plugin" | "skill" | "company"(D1 占位,本方向只填 plugin/skill)
    plugin_id: str                 # 复用现有 id 正则 ^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$
    version: str
    digest: str                    # sha256:...; 身份的一部分(kind:id:version:digest)
    name: str
    summary: str
    trust: TrustState              # 由 §1.1 推导,不来自 manifest.source
    trust_reasons: tuple[str, ...]
    signer_class: str
    install_state: "InstallState"
    entitlement_state: "EntitlementState"
    revoked: bool
    skill_origin: bool
    logo_url: str | None
    sources: tuple[str, ...]       # 发现来源(诊断用): "registry"|"local_cache"|"company_dir"|"skill_projection"
    namespace_reserved: bool

@dataclass(frozen=True)
class InstallState:
    installed: bool                # 该 (id,version) 在 cache 内
    installed_versions: tuple[str, ...]
    update_available: bool         # 目录有更高已批准版本

class EntitlementState(str, Enum):
    NOT_REQUIRED = "not_required"  # commerce.pricing_model in {None,"","free"}
    SATISFIED = "satisfied"        # 本地 entitlements.json 命中且未过期
    MISSING = "missing"
    EXPIRED = "expired"

@dataclass(frozen=True)
class CatalogResolution:           # resolver 的顶层输出(CLI/REST 同享)
    items: tuple[CatalogItem, ...]
    conflicts: tuple["IdentityConflict", ...]  # 同id异签 hard conflict(§3)
    registry_freshness: "FreshnessStatus"
    resolved_at: str               # RFC3339
    watermark_sequence: int

@dataclass(frozen=True)
class IdentityConflict:
    plugin_id: str
    version: str
    signer_a: str
    signer_b: str
    reason: str                    # "same_id_different_signer" | "namespace_hijack"
```

---

## 2. TUF 风格元数据布局（`.superclaw/registry/`）

### 2.1 新建模块 `packages/superclaw/src/superclaw/registry_metadata.py`

职责：定义 4 类 TUF 角色元数据的磁盘 JSON 形状、加载/验证链、watermark 持久化、freshness 判定。**所有签名复用 Direction 1 / `plugins.py:_verify_signature` 的 Ed25519 原语**（root 公钥仍来自 `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY`，语义升级为"只验角色元数据"，与 `plugin-trust-chain-hardening.md` §1 一致）。

磁盘布局（`.superclaw/registry/`，与现有 `.superclaw/plugins/cloud/registry` **共存**；后者保留为本地 fake-cloud 包源，前者是信任名单）：

```
.superclaw/registry/
  root.json            # offline root 签;声明当前有效 online key 集 + 委托规则
  root.json.sig
  timestamp.json       # online timestamp key 签;短 expires(默认24h);指向 snapshot 摘要
  timestamp.json.sig
  snapshot.json        # online snapshot key 签;单调 sequence;列 targets/delegated 的版本+digest
  snapshot.json.sig
  targets.json         # online targets key 签;官方 targets(kind:id:version:digest 可发现性)
  targets.json.sig
  delegated/
    <developer_id>.json      # online targets key 委托段;每开发者一段;含其 active/retired 公钥
    <developer_id>.json.sig
  trust-state.json     # 客户端持久化: 见过的最高 sequence 水位 + 最近 freshness
```

### 2.2 JSON 形状（field-level）

`root.json`：
```json
{
  "schema_version": "1.0.0",
  "type": "root",
  "sequence": 7,
  "expires_at": "2027-06-13T00:00:00Z",
  "roles": {
    "timestamp": {"keyids": ["ts-2026"], "threshold": 1},
    "snapshot":  {"keyids": ["snap-2026"], "threshold": 1},
    "targets":   {"keyids": ["tg-2026"], "threshold": 1}
  },
  "keys": {
    "ts-2026":   {"keytype": "ed25519", "public": "ed25519:..."},
    "snap-2026": {"keytype": "ed25519", "public": "ed25519:..."},
    "tg-2026":   {"keytype": "ed25519", "public": "ed25519:..."}
  }
}
```
`timestamp.json`（短时效，freshness 锚点）：
```json
{ "type": "timestamp", "sequence": 1422, "expires_at": "2026-06-14T00:00:00Z",
  "snapshot": {"sequence": 1422, "digest": "sha256:..."} }
```
`snapshot.json`（anti-rollback 单调序列）：
```json
{ "type": "snapshot", "sequence": 1422, "expires_at": "2026-06-20T00:00:00Z",
  "meta": { "targets.json": {"sequence": 88, "digest": "sha256:..."},
            "delegated/dev.acme.json": {"sequence": 12, "digest": "sha256:..."} } }
```
`targets.json` / `delegated/<dev>.json`（可发现性声明，**只声明存在+可安装，绝不授权运行**）：
```json
{ "type": "targets", "sequence": 88, "expires_at": "2026-07-13T00:00:00Z",
  "delegations": [
    {"developer_id":"dev.acme","paths":["dev.acme.*"],
     "keyids":["acme-2026"],"threshold":1,"terminating":true}
  ],
  "keys": {"acme-2026":{"keytype":"ed25519","public":"ed25519:...","status":"active"}},
  "targets": {
    "plugin:dev.acme.pay:0.2.0": {
      "digest":"sha256:...","length":40213,
      "custom":{"kind":"plugin","acceptance_level":"L2","commerce_pricing":"metered","skill_origin":false}
    }
  } }
```
`trust-state.json`（客户端水位，对应 hardening §2.1）：
```json
{ "schema_version":"1.0.0",
  "watermark": {"root":7,"timestamp":1422,"snapshot":1422,"targets":88,
                "delegated":{"dev.acme":12}},
  "last_timestamp_fetch_at":"2026-06-13T11:00:00Z",
  "last_timestamp_expires_at":"2026-06-14T00:00:00Z" }
```

### 2.3 客户端 fetch/verify flow

```python
def load_trust_registry(registry_root: Path, *, root_public_key: str) -> TrustRegistry: ...
def refresh_trust_registry(registry_root: Path, *, source_url: str | None, root_public_key: str) -> RefreshResult: ...
def assert_freshness_for_high_risk(registry: TrustRegistry, *, now: float) -> None:  # 过期/缺失 → raise RegistryFreshnessError
```

加载顺序（每一步失败即 fail-closed）：

1. 读 `root.json`+`.sig`，用内置 root 公钥验签。拒绝 `sequence < watermark.root`（anti-rollback）。从中取 online key 集。
2. 读 `timestamp.json`+`.sig`，用 root 声明的 timestamp keyid 验签。校验 `expires_at > now`（**freshness**）。拒绝 `sequence < watermark.timestamp`。
3. 读 `snapshot.json`+`.sig`，timestamp 中声明的 snapshot digest 必须匹配。拒绝 `sequence < watermark.snapshot`。
4. 读 `targets.json` + 每个 `delegated/<dev>.json`，digest 必须匹配 snapshot.meta；签名用对应 keyid 验。委托段只对其 `paths` 内的 id 有效（`dev.acme.*` 段不能声明 `superclaw.*`）。
5. 全通过后 **CAS 更新** `trust-state.json` 水位为各 sequence 的 max。

**freshness fail-closed（高危操作）**：`assert_freshness_for_high_risk` 在 timestamp 缺失或 `expires_at <= now` 时 raise。调用点 = 加载/执行任何 `high_risk=True`（commerce 标支付 / network probe 权限）的 developer/official 包之前。普通包过期 → 仅 `freshness_ok=False` 警告，不阻断（对应 hardening §2.2 分级）。

**refresh 离线/拉取失败**：`refresh_trust_registry` 拿不到新 timestamp 时**不覆盖**本地缓存（保留旧的，靠 expires_at 自然失效），并在 `RefreshResult.error` 标注；绝不静默回退到无名单状态。

---

## 3. 命名空间保留 + 同名异签硬冲突（loader fail-closed 位置）

### 3.1 内核常量（写死）
- `trust_state.py:FIRST_PARTY_NAMESPACES = ("superclaw.", "first_party.")`。
- 新增 `plugins.py` 顶层异常 `class NamespaceViolationError(PluginVerificationError)` 与 `class IdentityConflictError(PluginVerificationError)`（继承 PluginVerificationError，使现有 except 链不破）。

### 3.2 loader 强制点 1 —— 执行前验证（`plugin_proxy.py:312 _verify_cached_package_before_execution`）

在 `verify_plugin_integrity` 成功、`check_plugin_revocation` 之后，新增：

```python
# 命名空间硬隔离: 保留前缀只能由根公钥签名
trust = derive_trust_state(plugin_id=package.plugin_id, verifier_verdict=..., registry=..., revoked=False, high_risk=_is_high_risk(package), now=time.time())
if trust.state is TrustState.UNTRUSTED and "namespace_hijack" in trust.reasons:
    return "PLUGIN_NAMESPACE_VIOLATION"
if trust.state is TrustState.UNTRUSTED and "developer_freshness_stale" in trust.reasons:
    return "PLUGIN_TRUST_STALE"
```
返回新错误码 `PLUGIN_NAMESPACE_VIOLATION` / `PLUGIN_TRUST_STALE`（与现有 `PLUGIN_SIGNATURE_INVALID`/`PLUGIN_REVOKED` 同级）。**这是运行授权门**，确保命名空间劫持包永不被 `_gate_passes`(`plugin_runtime_projection.py`) 放过。

### 3.3 loader 强制点 2 —— 枚举去重（`plugin_runtime_projection.py:95 latest` 构建处）

当前 `latest` 仅按 id 取最高版本，**未检测同 id 异签**。新增：在 `gate_passing_plugins`/`available_plugins` 的 `latest` 收集循环里，对同一 `plugin_id` 的多个候选记录其 `signer_class`（从 cached manifest 的 provenance 通过 verifier 计算）。若同 id 出现 ≥2 个不同 `signer_class`（如官方缓存 + 本地同名） → **不静默取 max 版本**，而是：把该 id 整体从 `allowed` 排除并记入 `CatalogResolution.conflicts`（reason `same_id_different_signer`）。**fail-closed：冲突时拒绝全部同名候选，不让攻击者用本地同名包覆盖官方。** 这落实路线图 §111 "同 id 永远 hard conflict 拦截（不静默覆盖）"。

### 3.4 优先级
官方 > 开发者 > 本地 **仅用于展示排序**（CatalogItem 排序键），**不用于授权覆盖**。授权永远经 §3.2/§3.3 的 fail-closed 门。

---

## 4. CLI-backed catalog resolver（CLI 唯一事实源）

### 4.1 新建模块 `packages/superclaw/src/superclaw/catalog_resolver.py`

职责：聚合三来源发现 → 推导 TrustState → 检测冲突 → 输出 `CatalogResolution`。**API/Web 都包它，不另写聚合逻辑。**

```python
def resolve_catalog(
    *,
    kind: str | None = None,              # "plugin"|"skill"|"company"|None=all
    cache_root: Path | None = None,
    cloud_root: Path | None = None,       # 复用现有 plugin_cloud registry 作包源
    registry_root: Path | None = None,    # 新 .superclaw/registry TUF 名单
    companies_root: Path | None = None,   # 新 .superclaw/companies(本地公司发现)
    entitlement_file: Path | None = None,
    revocation_file: Path | None = None,
    public_key: str | None = None,
    now: float | None = None,
) -> CatalogResolution: ...

def resolve_trust_state(plugin_id: str, version: str, **roots) -> TrustDerivation: ...  # 单条 id@version 推导

def refresh_catalog(*, registry_root: Path, source_url: str | None, public_key: str) -> RefreshResult: ...  # 包 registry_metadata.refresh
```

发现来源（标 `CatalogItem.sources`）：
- `registry`：`plugin_cloud.list_registry_plugins(cloud_root)`（现有）。
- `local_cache`：`plugins.list_cached_plugins(cache_root)`（现有）→ TrustState 多为 `LOCAL` 或 `OFFICIAL`（若缓存的是官方签名包）。
- `company_dir`：扫 `.superclaw/companies/*/superclaw-company.json`（Direction 1 的 company kind，本方向只发现+标 `kind:"company"`，TrustState 同样经验证推导；commit/实例化不在本方向）。
- `skill_projection`：`available_plugins` 中 `skill_origin` 的子集（复用 `is_skill_origin_plugin`）。

**硬约束**：本地发现枚举 **必须复用 `gate_passing_plugins()` 的 fail-closed 门**（沿用 memory `skill-sync-mechanism` 教训：不能裸 `list_cached_plugins`），TrustState 才与运行授权一致。

### 4.2 CLI 命令（新 Typer 子应用 `catalog_app`，cli.py:200 后注册 `app.add_typer(catalog_app, name="catalog")`，并新增 `trust_app` name="trust"）

```
superclaw catalog resolve [--kind plugin|skill|company] [--json]
superclaw catalog refresh [--source-url URL] [--json]
superclaw catalog list   --kind plugin|skill|company [--json]   # 方向一 §88 的 list 也落这里(共用 resolver)
superclaw trust state <plugin_id@version> [--json]
```

`superclaw catalog resolve --json` 输出（CatalogResolution 序列化，**REST 直接转发同一形状**）：
```json
{ "ok": true, "resolved_at": "2026-06-13T11:00:00Z", "watermark_sequence": 1422,
  "registry_freshness": {"fresh": true, "expires_at": "2026-06-14T00:00:00Z", "stale_reason": null},
  "conflicts": [],
  "items": [
    { "kind":"plugin","plugin_id":"superclaw.designer","version":"1.2.0",
      "digest":"sha256:...","name":"Designer","summary":"...",
      "trust":"official","trust_reasons":[],"signer_class":"root",
      "namespace_reserved":true,
      "install_state":{"installed":true,"installed_versions":["1.2.0"],"update_available":false},
      "entitlement_state":"not_required","revoked":false,"skill_origin":false,
      "logo_url":"/api/plugins/superclaw.designer/logo?version=1.2.0",
      "sources":["registry","local_cache"] }
  ] }
```
`superclaw trust state dev.acme.pay@0.2.0 --json`：
```json
{ "ok": true, "plugin_id":"dev.acme.pay","version":"0.2.0",
  "trust":"developer","signer_class":"developer:acme-2026",
  "namespace_reserved":false,"revoked":false,"freshness_ok":true,
  "rollback_ok":true,"reasons":[] }
```
错误形状沿用 `{"ok": false, "error": "..."}`（cli.py:2120 模式）。`catalog refresh` 拉取失败 → `{"ok": false, "error": "...", "kept_cached": true}`（fail-closed 不清缓存）。

---

## 5. API 端点（包同一 resolver，零并行实现）

新增（`apps/api/main.py`，紧邻 `/v1/plugins` 4713）：

| Method | Path | 请求 | 响应 |
|---|---|---|---|
| GET | `/v1/catalog` | query `kind?`,`trust?`(过滤) | `resolve_catalog(...)` 的 `CatalogResolution` JSON（与 CLI 同形状）|
| GET | `/v1/catalog/trust/{plugin_id}/{version}` | — | `resolve_trust_state(...)` 的 `TrustDerivation` JSON |
| POST | `/v1/catalog/refresh` | `{ "source_url": str|null }` | `refresh_catalog(...)` 的 `RefreshResult` |

实现：每个端点 **直接调 `catalog_resolver.*`**（与 CLI 同一函数），不复制聚合/推导逻辑。沿用 `Depends(require_control_token)`。

**`/v1/plugins`、`/v1/skills` 向后兼容**：保持现有形状不变，但内部改为从 `resolve_catalog(kind="plugin"/"skill")` 投影出旧字段（新增 `trust`/`trust_reasons`/`signer_class`/`namespace_reserved` 字段，旧 `verified` 保留为 `trust in {official,developer}` 的派生别名）。这样既不破坏现有 Web 调用，又让旧端点带上 TrustState（路线图 §110 "复用并泛化现有端点"）。`/v1/catalog` 是顶层联合视图。

---

## 6. ui_contracts.py 新增（共享契约，表层不硬编码）

在 `ui_contracts.py` 新增（与 `build_skill_sync_contract` 同级）：

```python
TRUST_STATE_CONTRACT = {
    "states": [
        {"id": "official",  "label_en": "Official",  "label_zh": "官方",   "badge": "good"},
        {"id": "developer", "label_en": "Developer", "label_zh": "开发者", "badge": "info"},
        {"id": "local",     "label_en": "Local",     "label_zh": "本地",   "badge": "neutral"},
        {"id": "untrusted", "label_en": "Untrusted", "label_zh": "不受信任","badge": "warn"},
    ],
    "priority": ["official", "developer", "local"],   # 仅展示排序;授权见内核
    "derived_from": "verification_result_not_manifest_source",  # 文档化护栏
}

CATALOG_UNION = {                       # 与方向一 §87 协同;本方向填 source 徽章枚举+冲突规则
    "kinds": ["plugin", "skill", "company"],
    "discovery_sources": ["registry", "local_cache", "company_dir", "skill_projection"],
    "conflict_rules": {
        "same_id_different_signer": "hard_conflict",   # §3.3
        "namespace_reserved_prefixes": ["superclaw.", "first_party."],
        "namespace_violation": "fail_closed",
    },
    "resolver": {
        "resolve_url": "/v1/catalog",
        "trust_url": "/v1/catalog/trust/{plugin_id}/{version}",
        "refresh_url": "/v1/catalog/refresh",
        "cli": {"resolve": "superclaw catalog resolve --json",
                "trust": "superclaw trust state <id@version> --json"},
    },
    "freshness": {"high_risk_fail_closed": True, "default_ttl_hours": 24},
}

def build_trust_state_contract() -> dict: return dict(TRUST_STATE_CONTRACT)
def build_catalog_union_contract() -> dict: return dict(CATALOG_UNION)
```

这两个契约通过 `/api/plugins/status` 或新 `/api/contracts/catalog` 暴露，Web 从中渲染徽章 label / badge class / 冲突文案，**不在前端硬编码** official/developer/local 字符串。

---

## 7. Web 改动（从 TrustState 渲染徽章，本地发现）

### 7.1 类型升级（App.tsx:1622-1638）
- `PluginCatalogItem` 新增 `trust?: 'official'|'developer'|'local'|'untrusted'` 与 `trust_reasons?: string[]`、`signer_class?: string`、`namespace_reserved?: boolean`。`source` 字段保留（back-compat），但 **徽章改读 `trust`**。
- `RegistryPluginInfo`（registry 行类型）新增同上字段（来自升级后的 `/v1/plugins`/`/v1/catalog`）。

### 7.2 映射处（App.tsx:3728-3744 registry→catalog 的 useMemo）
- 把硬编码 `source: 'registry'` 旁边补 `trust: plugin.trust ?? (plugin.verified ? 'official' : 'local')`（过渡期回退：未带 trust 的旧 payload 用 verified 近似，但**不再凭 manifest.source 推 official**）。
- 改 `loadPluginControl`（5321-5347）：把 `/v1/plugins` 换成 `/v1/catalog`（保留 `/v1/plugins` 兼容回退），`setRegistryPlugins(resolution.items)`。

### 7.3 徽章组件
- 新增 `function trustBadge(item): {label, cls}`，**从 `TRUST_STATE_CONTRACT`**（经 `/api/contracts/catalog`）取 label/cls，渲染在 `pluginCatalogSourceLabel`（4900）与卡片头 + 详情头（10314 替换 `verified` 单徽章为 TrustState 徽章）。
- `pluginCatalogInstallBlockedReason`（4906）新增：`item.trust === 'untrusted'` → 返回冲突/命名空间/freshness 文案（从 `conflict_rules`）。

### 7.4 本地来源发现
- `/v1/catalog?kind=plugin` 已聚合 `local_cache`/`company_dir`/`skill_projection`，Web 把 `sources` 含 `local_cache`/`company_dir`/`skill_projection` 的条目标 `trust:'local'` 本地徽章（无须前端再扫目录，内核已聚合）。
- 冲突展示：`CatalogResolution.conflicts` 非空时，在目录顶部渲染一条 hard-conflict 警示（红），列出被拦截的 id（不可安装），文案从 `CATALOG_UNION.conflict_rules`。

---

## 8. 原子 PR 拆分（B1..Bn）

| PR | 标题 (conventional) | scope (files) | 验收 | 测试 | 依赖 |
|---|---|---|---|---|---|
| **B1** | `feat(web): render trust badges from existing verification, not manifest.source` | App.tsx 1622-1638/3728-3744/4900/10314；ui_contracts `TRUST_STATE_CONTRACT`+`build_trust_state_contract`；main.py 新 `/api/contracts/catalog`(投影 contract) | 早期低风险表层：徽章从已有 `verified`/signer 推导而非 `source`；新增 4 态徽章；契约驱动 label | `apps/web/tests/trust-badge.test.ts`；`tests/test_ui_contracts_trust.py` | — |
| **B2** | `refactor(kernel): surface verifier signer class as authoritative TrustState` | 新建 `trust_state.py`（`TrustState`/`TrustDerivation`/`derive_trust_state` 纯函数）；`plugins.py:125` 让 `verify_plugin_package` 传出 `signer_class`（向后兼容：result 加可选字段） | 状态机穷举单测全绿；`first_party` manifest 但非根签 → `UNTRUSTED`(namespace_hijack)；root+保留段 → `OFFICIAL` | `tests/test_trust_state.py`（穷举 official/developer/local/untrusted + namespace_hijack + freshness/rollback 降级） | D1(PackageTrustVerifier) |
| **B3** | `feat(kernel): TUF-style registry metadata with anti-rollback + freshness fail-closed` | 新建 `registry_metadata.py`（root/timestamp/snapshot/targets/delegated 加载验证链、watermark CAS、`assert_freshness_for_high_risk`）；磁盘 `.superclaw/registry/` | sequence 回滚被拒；timestamp 过期+高危 → raise；委托段越权声明 `superclaw.*` 被拒；离线 refresh 不清缓存 | `tests/test_registry_metadata.py`（rollback/freshness/delegation-path/offline-keep） | B2 |
| **B4** | `feat(kernel): enforce namespace reservation + same-id-different-signer hard conflict in loader` | `plugins.py`(异常类)；`plugin_proxy.py:312`(命名空间/freshness 错误码)；`plugin_runtime_projection.py:95`(同 id 异签拦截+conflicts) | 保留前缀非根签包 `_gate_passes` 拒绝并出错误码；本地同名包不覆盖官方，整体进 conflicts | `tests/test_namespace_enforcement.py`；扩 `tests/test_plugin_runtime_projection.py` | B2,B3 |
| **B5** | `feat(cli): CLI-backed catalog resolver + trust state commands` | 新建 `catalog_resolver.py`；cli.py 新 `catalog_app`/`trust_app` + 命令 + `--json` | `superclaw catalog resolve --json`/`trust state <id@v> --json` 形状如 §4.1；本地发现复用 fail-closed 门；conflicts 上报 | `tests/test_cli_catalog.py`（resolve/refresh/trust + 冲突 + 本地发现门一致性） | B2,B3,B4 |
| **B6** | `feat(api): /v1/catalog wraps the same resolver; backfill trust on /v1/plugins,/v1/skills` | main.py 新 3 端点；`/v1/plugins`/`/v1/skills` 内部改投影 resolver（保留旧字段+新增 trust） | REST 与 CLI 输出逐字段一致(同 resolver)；旧字段不破；新增 trust 字段 | `tests/test_api_catalog.py`（REST==CLI 等价；back-compat 旧字段在） | B5 |
| **B7** | `feat(web): live catalog from /v1/catalog with TrustState badges, local discovery, conflict banner` | App.tsx loadPluginControl/类型/映射/徽章/冲突横幅；`/api/contracts/catalog` 驱动 | 切到 `/v1/catalog`（回退兼容）；本地/公司/技能来源标本地徽章；hard-conflict 横幅；untrusted 阻装 | `apps/web/tests/catalog-resolver.test.ts`、`apps/web/tests/conflict-banner.test.ts` | B1,B6 |

> B1 为路线图明确的 "badge-from-existing-verification" 早期低风险表层 PR（先有徽章、热更新后补）。每个 PR 仍须按项目铁律走 Codex+Gemini 验收门。

---

## 9. fail-closed / 治理红线核对

1. **TrustState 由验证推导**：`derive_trust_state` 是纯函数，输入是 `PackageTrustVerifier` 的 verdict + 名单，从不读 `manifest.source.type`/`provenance.build_type` 做信任判定（仅作"候选声明"）。`first_party` 字段无法把任意包提升为 official。
2. **命名空间双重 fail-closed**：①TrustState 推导处降 UNTRUSTED；②loader（`plugin_proxy._verify_cached_package_before_execution`）出错误码拒载；③枚举（`gate_passing_plugins`）同 id 异签整体排除。三层不依赖单点。
3. **freshness 高危 fail-closed**：支付/扫描类（commerce 标支付 / network probe 权限）在 timestamp 过期或拉不到名单时拒载（`assert_freshness_for_high_risk`），普通包仅降级警告——与 hardening §2.2 分级一致。
4. **anti-rollback**：watermark 持久化 + sequence 单调；旧 sequence 即使签名有效也拒（高危场景降 UNTRUSTED）。
5. **目录只读发现，不授权运行**：`CatalogItem` 只声明 `install_state`/`entitlement_state`；运行授权仍走现有 `_gate_passes`(entitlement/policy/revocation)。SSE/REST 是投影，权威是 CLI/core resolver + durable `.superclaw/registry/trust-state.json`。
6. **表层零新增语义**：Web/API 只渲染/转发 resolver 输出；徽章 label、冲突文案、保留前缀均来自 `ui_contracts`，前端不能硬编码一份与内核不一致的 official 名单或覆盖优先级。

---

## 10. back-compat / 迁移

- **旧 `revocations.json`（未签名）**：B3 引入 TUF revocation 通道，但**保留** `plugins.py:362 _check_revocation` 读明文 revocations 作为兜底（双通道：明文 revocation 命中即拒，TUF 名单是叠加新鲜度）。不破坏现有 `/v1/plugins/revocations`、`build_plugin_status_payload`。
- **旧 `/v1/plugins`/`/v1/skills` 形状**：B6 仅**新增**字段（trust/signer_class/...），保留 `verified`/`package_digest`/`acceptance_level` 等所有现有键；`verified` 派生为 `trust in {official,developer}`。现有 Web 调用与测试不需改即可继续工作。
- **`.superclaw/plugins/cloud/registry`（现 fake-cloud 包源）保留**：新 `.superclaw/registry`（信任名单）与之**共存、互不替换**；前者管"字节从哪取"，后者管"是否可信/可发现"。
- **`SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` 语义升级**：从"直接验包签名"扩展为"也验角色元数据(root)"。无名单环境（未铺 `.superclaw/registry`）下，resolver 退化为"仅 official(根签)/local(local_dev)/untrusted"，**不引入 developer 态**（fail-closed：没有委托名单就没有 developer 信任），现有官方/本地行为不变。
- **`local_dev_trust`** 行为保留：开发者模式下本地未签名包仍 `LOCAL` 态可载，但**永不**命中保留命名段（B4 强制）。

---

## 11. 给对抗评审的开放问题（请 Codex/Gemini 压测）

1. **TrustState 推导处与 loader 强制点的双判定一致性**：`derive_trust_state`（§1.1）与 `plugin_proxy`(§3.2)/`plugin_runtime_projection`(§3.3) 三处都做命名空间/冲突判定——是否存在某条路径（如直接 `/v1/catalog` 展示）绕过 loader 门、让 untrusted 包显示成可安装？是否应把 §3 收敛到 `derive_trust_state` 单一定义点，loader 只消费其 reasons？
2. **同 id 异签拦截的可用性 vs 安全权衡**：B4 选择"冲突时整体排除全部同名候选"。攻击者能否用此做 DoS（放一个同名本地包就让官方包不可用）？是否应改为"官方/开发者优先保留、仅拒绝本地冲突方"？哪个更 fail-closed？
3. **freshness fail-closed 的"high_risk"判定**：以 commerce 支付标记 + network probe 权限界定高危是否足够？是否漏掉 filesystem 越权 / MCP 横向移动类高危？误判普通包为高危导致离线全不可用的回归风险？
4. **无名单环境的 developer 态缺失**：未铺 `.superclaw/registry` 时一律无 developer 信任——这对"开发者插件热更新"是否过严，会不会逼用户开 `local_dev_trust` 而削弱安全？
5. **watermark CAS 与并行会话竞争**：`trust-state.json` 水位更新在多会话/多 worktree 共享 checkout 下是否有竞态（参照 memory `shared-checkout-commit-race`）？是否需要私有 index/CAS 模式？
6. **`/v1/plugins` 投影改造的回归面**：B6 把旧端点内部换成 resolver，是否会因聚合更重（命名空间/freshness/冲突计算）拖慢现有 Web 加载？是否需缓存 resolver 结果？
7. **company kind 在本方向只发现不实例化**：`company_dir` 发现是否会让 Web 误以为可"安装公司"？kind=company 的 install_state 语义是否需要在契约里显式标 `instantiable:false`？


### 原子 PR 拆分（汇总表）

| PR | 范围 | 验收标准 | 依赖 |
|---|---|---|---|
| feat(web): render trust badges from existing verification, not manifest.source | apps/web/src/App.tsx (PluginCatalogItem type 1622-1638, registry→catalog map 3728-3744, pluginCatalogSourceLabel 4900, verified badge 10314); packages/superclaw/src/superclaw/ui_contracts.py (TRUST_STATE_CONTRACT + build_trust_state_contract); apps/api/main.py (new /api/contracts/catalog projecting the contract) | Early low-risk surface PR: catalog cards render official/developer/local/untrusted badges derived from the already-available verification signals (signer/verified), NOT manifest.source; badge labels/classes come from the shared contract, not hardcoded strings. | none |
| refactor(kernel): surface verifier signer class as authoritative TrustState | packages/superclaw/src/superclaw/trust_state.py (new: TrustState enum, TrustDerivation dataclass, derive_trust_state pure fn, FIRST_PARTY_NAMESPACES); packages/superclaw/src/superclaw/plugins.py:125 (thread signer_class out of verify_plugin_package as optional back-compat field) | Exhaustive state-machine unit tests pass: first_party manifest but non-root signature => UNTRUSTED(namespace_hijack); root+reserved-namespace => OFFICIAL; developer keyid in delegated targets => DEVELOPER; local_dev => LOCAL only outside reserved namespaces. Pure function, no I/O. | Direction 1 PackageTrustVerifier |
| feat(kernel): TUF-style registry metadata with anti-rollback + freshness fail-closed | packages/superclaw/src/superclaw/registry_metadata.py (new: root/timestamp/snapshot/targets/delegated load+verify chain, watermark CAS to .superclaw/registry/trust-state.json, assert_freshness_for_high_risk, refresh_trust_registry) | Lower sequence than watermark is rejected even when signature valid; expired timestamp + high-risk op raises (fail-closed); a delegated developer segment claiming superclaw.* paths is rejected; offline refresh keeps the cached metadata instead of clearing it. | refactor(kernel): surface verifier signer class as authoritative TrustState |
| feat(kernel): enforce namespace reservation + same-id-different-signer hard conflict in loader | packages/superclaw/src/superclaw/plugins.py (NamespaceViolationError, IdentityConflictError); packages/superclaw/src/superclaw/plugin_proxy.py:312 (PLUGIN_NAMESPACE_VIOLATION / PLUGIN_TRUST_STALE error codes); packages/superclaw/src/superclaw/plugin_runtime_projection.py:95 (same-id-different-signer detection, conflicts in latest-collection loop) | A package using a reserved prefix without a root signature is rejected by _gate_passes with the new error code; a local package with the same id as an official one does not silently override it — the whole id is excluded and recorded as a hard conflict. | feat(kernel): TUF-style registry metadata with anti-rollback + freshness fail-closed |
| feat(cli): CLI-backed catalog resolver + trust state commands | packages/superclaw/src/superclaw/catalog_resolver.py (new: resolve_catalog, resolve_trust_state, refresh_catalog aggregating registry/local_cache/company_dir/skill_projection through the fail-closed gate); packages/superclaw/src/superclaw/cli.py (new catalog_app + trust_app, commands with --json) | superclaw catalog resolve --json / catalog refresh --json / trust state <id@version> --json emit the CatalogResolution/TrustDerivation shapes; local discovery reuses gate_passing_plugins (not bare list_cached_plugins); conflicts surface in output; refresh failure keeps cache (kept_cached:true). | feat(kernel): enforce namespace reservation + same-id-different-signer hard conflict in loader |
| feat(api): /v1/catalog wraps the same resolver; backfill trust on /v1/plugins and /v1/skills | apps/api/main.py (new GET /v1/catalog, GET /v1/catalog/trust/{plugin_id}/{version}, POST /v1/catalog/refresh — each calls catalog_resolver.*; /v1/plugins 4713 and /v1/skills 4734 internally project the resolver, adding trust fields while preserving existing keys) | REST output is field-for-field equal to the CLI (same resolver, no parallel impl); existing /v1/plugins and /v1/skills keys (verified, package_digest, acceptance_level) remain present; new trust/signer_class fields added. | feat(cli): CLI-backed catalog resolver + trust state commands |
| feat(web): live catalog from /v1/catalog with TrustState badges, local discovery, conflict banner | apps/web/src/App.tsx (loadPluginControl 5321-5347 switch to /v1/catalog with fallback; PluginCatalogItem/RegistryPluginInfo types; registry→catalog map; trustBadge component; pluginCatalogInstallBlockedReason untrusted handling; hard-conflict banner) driven by /api/contracts/catalog | Catalog loads from /v1/catalog (with compat fallback to /v1/plugins); local/company/skill-projection sources render the local badge; a hard-conflict banner lists blocked ids; untrusted items are install-blocked with contract-sourced copy. | feat(api): /v1/catalog wraps the same resolver; backfill trust on /v1/plugins and /v1/skills |



### 待评审的开放问题

- TrustState 推导处(trust_state.derive_trust_state)与三个 loader 强制点(plugin_proxy.py:312, plugin_runtime_projection.py:95, /v1/catalog 展示)的命名空间/冲突判定是否会出现某条路径绕过 loader 门、让 untrusted 包显示成可安装？是否应把 §3 判定收敛到 derive_trust_state 单一定义点，loader 仅消费 reasons？
- 同 id 异签 hard conflict 选择'整体排除全部同名候选'是否给了攻击者 DoS 面(放一个同名本地包即让官方包不可用)？改为'官方/开发者优先保留、仅拒本地冲突方'是否更安全且更可用？
- freshness fail-closed 的 high_risk 判定以 commerce 支付标记 + network probe 权限界定是否足够？是否漏掉 filesystem 越权 / MCP 横向移动类高危？误判普通包为高危导致离线全不可用的回归风险有多大？
- 未铺 .superclaw/registry 名单时一律无 developer 信任(fail-closed)——这对'开发者插件热更新'是否过严，会不会逼用户开 SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST 反而削弱安全？
- trust-state.json watermark CAS 更新在多会话/多 worktree 共享 checkout 下是否有竞态(参照 shared-checkout-commit-race 教训)？是否需要私有 GIT_INDEX_FILE / 文件锁 CAS？
- B6 把 /v1/plugins 内部改成 resolver 投影，聚合更重(命名空间/freshness/冲突计算)是否拖慢现有 Web 加载？是否需要 per-process 缓存 resolver 结果？
- company kind 在本方向只发现不实例化——Web 是否会误以为可'安装公司'？kind=company 的 install_state 是否需要在 CATALOG_UNION 契约里显式标 instantiable:false？

### 已识别风险

- 把 §3 命名空间/冲突判定分散在三处(trust_state + plugin_proxy + plugin_runtime_projection)有定义点漂移风险；若不收敛到单一函数，未来改一处漏一处会重开命名空间劫持洞。建议 derive_trust_state 为唯一判定、其余消费其 reasons。
- /v1/plugins、/v1/skills 改为 resolver 投影是行为面较大的重构(B6)：现有 Web/测试依赖旧字段，若投影遗漏任一现有键(verified/package_digest/acceptance_level/compatibility/platforms)会静默破坏目录详情卡(App.tsx:10318-10329)。必须逐字段快照比对。
- TUF freshness fail-closed 若 high_risk 判定过宽，会在离线/拉不到名单时把普通插件也锁死，造成可用性回归——与现有 MAX_OFFLINE_GRACE_SECONDS 宽限语义(plugin_cloud.py:21)需协调，否则两套过期逻辑互相矛盾。
- watermark(.superclaw/registry/trust-state.json)与现有 .superclaw/plugins/* 状态文件并存，多会话共享 checkout 下并发写有损坏/回滚水位风险(memory shared-checkout-commit-race / queue-drift)。需 CAS + 字节级校验。
- developer 态依赖 delegated targets 委托名单；若 B3 的委托 path 约束(dev.acme.* 不能声明 superclaw.*)实现有误，会让开发者段越权签官方命名段——这正是命名空间劫持的另一入口，必须在 registry_metadata 加载链 fail-closed。
- B2 让 verify_plugin_package 多传 signer_class 是公共函数签名变更：orchestrator.py:210、plugin_mcp_proxy.py:498/522、skill_sync.py:451 等多个调用点都传 public_key，需确认新增字段为可选返回、不破坏既有解包，否则连锁回归。
- 无名单(未铺 registry)的退化路径若实现不当，可能让 resolver 在缺 timestamp 时对所有 developer 候选静默降级为 untrusted 而不给任何用户可见原因，造成'插件突然消失'的体验黑洞——需在 CatalogResolution.registry_freshness.stale_reason 明确暴露。


---


## 3. 方向三　App 自更新（Core-governed Orchestrator + Tauri as installer）

**落地概述**：方向三 — App 自更新：Core-governed Update Orchestrator + Tauri as installer。决策权（版本权威、验签、preflight 阻断、迁移/回滚）全部留在 Python core/CLI，API 仅包装同一份 core 逻辑，Tauri 只做纯 OS 级 download/swap/relaunch 且必须由 core 暴露 apply 后才执行。CLI(pip) 用户走 `pip install -U`，与桌面整包替换共用同一份多维版本契约。本方向只到内核地基（C1–C5 内核侧，零 UI），UI/Tauri 接线（C6+）属 P6 表层，按路线图最后做。


## 方向三实现规格：App 自更新（Core-governed Update Orchestrator）

> 范围：路线图 §2 方向三 P0（全部内核侧，不碰 UI），即 C1–C5。C6+（Settings 卡片 / Tauri 接线 / CI 签名公证）列为依赖项但属 P6 表层，本规格只给契约钩子，不实现 UI。
> 铁律对齐：决策权（是否更新、验签、迁移）独占于 Python core/CLI（北极星护栏 3）；API 只包装同一 core，不写并行实现；fail-closed 默认（护栏 4）；多维版本身份而非单一 display name（护栏 5 的版本等价物）。

---

### 0. 现状基线（已核实 file:line）

- **版本散落 6 处，无单一事实源**：`VERSION`=`0.1.0`；`pyproject.toml:3` version=`0.1.0`；`apps/desktop/src-tauri/tauri.conf.json:4` version=`0.1.0`；`apps/desktop/src-tauri/Cargo.toml:3` version=`0.1.0`；`plugin_proxy.py:59` `DEFAULT_RUNTIME_VERSION="0.1.0"`；`apps/api/main.py:1444` `FastAPI(..., version="0.1.0")`（另 `:770`、`:1760` 也硬编码 `"0.1.0"`）。
- **CLI 无顶层 `version` 命令**：只有 helper `cli.py:916 _superclaw_version()`（`importlib.metadata.version("superclaw")` → fallback 读 `VERSION`）。`runtime status`（cli.py:1194）把它塞进 `build_runtime_status_payload(runtime_version=...)`。
- **Tauri 仅展示版本，无 updater**：`lib.rs:14-15` `DEFAULT_RELEASE_CHANNEL="beta"` / `DEFAULT_UPDATE_MODE="manual"`；`lib.rs:262 desktop_shell_info_payload()` 用 `env!("CARGO_PKG_VERSION")`；`tauri.conf.json` 无 `plugins.updater` 段。手动更新文档 `docs/desktop-manual-update.md`（git pull 重建 / 手动替换 .app）。
- **state.db 无 schema 版本机制**：`state.py:67 _init()` 全靠 `CREATE TABLE IF NOT EXISTS` + 一次性列迁移 `state.py:267 _migrate_chat_sessions_workspace_column`（`PRAGMA table_info` 探列后 `ALTER TABLE ADD COLUMN`）。**没有 `PRAGMA user_version`**，没有 backup，没有 min-reader-version。这是 C4 的核心缺口。
- **liveness/lock 原语已就绪（preflight 直接复用，不新造）**：
  - `liveness.py:67 effective_run_state(session)` —— 唯一 is-live 判定；`EXECUTING_RUN_STATUSES={running,verifying}`、`PENDING_RUN_STATUSES={created,queued}`、`WAITING_FOR_HUMAN_GATE`。
  - `state.py:510 list_runs()`、`state.py:1179 list_approvals(status="pending", ...)`、`state.py:1134 list_workspace_locks()`、`state.py:1049 acquire_workspace_lock()`。
- **验签原语已就绪（C2 复用）**：`plugins.py:351 _verify_signature(digest, signature, public_key)`（Ed25519，签名格式 `ed25519:<b64>`，验的是 `digest.encode()`）。release manifest 验签复用同一算法，但用**独立根公钥** `SUPERCLAW_RELEASE_ROOT_PUBLIC_KEY`（绝不复用 plugin 根公钥 —— 域隔离）。
- **API 包装模式**：所有 `/api/*` 端点用 `Depends(require_control_token)` 包装 core；`store`/`orchestrator` 在 `create_app()` 内构造（main.py:1444 起），`/health`（main.py:2032）是 ungated 探活。

---

### 1. 新建模块/文件

#### 1.1 `packages/superclaw/src/superclaw/version_contract.py`（C1，多维版本契约单一事实源）
职责：把"一个 VERSION 不够"的多维兼容矩阵集中到一处，**从 `VERSION` 文件派生**所有运行期版本，禁止任何模块再硬编码 `"0.1.0"`。

```python
from dataclasses import dataclass, asdict
from pathlib import Path

# 多维兼容契约：每个维度独立演进，release manifest 的 min_supported_* 逐维比对。
DESKTOP_SHELL_DIM = "desktop_shell"      # Tauri 壳（Cargo/tauri.conf）—— OS 包替换粒度
BUNDLED_CORE_DIM  = "bundled_core"       # 冻进 .app 的 PyInstaller backend
CLI_CORE_DIM      = "cli_core"           # pip 安装的 superclaw 包
API_CONTRACT_DIM  = "api_contract"       # REST/SSE 契约版本（破坏式改契约才 +1）
STATE_SCHEMA_DIM  = "state_schema"       # state.db schema 版本（见 C4 SCHEMA_VERSION）
PLUGIN_CONTRACT_DIM = "plugin_contract"  # superclaw-plugin.schema.json 契约版本
PROJECTION_SCHEMA_DIM = "projection_schema"  # ui_contracts 投影契约版本

@dataclass(frozen=True)
class VersionContract:
    product_version: str        # 顶层语义版本（VERSION 文件，单一事实源）
    cli_core: str               # = product_version
    bundled_core: str | None    # 仅装机 app 注入；pip 用户为 None
    desktop_shell: str | None   # 仅桌面壳注入（Tauri 经 shell_info 传入）；CLI 为 None
    api_contract: int           # 整数单调递增；当前 1
    state_schema: int           # = state.SCHEMA_VERSION
    plugin_contract: int        # = superclaw-plugin.schema.json schema_version
    projection_schema: int      # ui_contracts 投影契约；当前 1
    git_sha: str | None         # 构建期注入（CI），运行期只读
    channel: str                # stable|beta|dev，来自 SUPERCLAW_RELEASE_CHANNEL

API_CONTRACT_VERSION = 1
PROJECTION_SCHEMA_VERSION = 1

def read_product_version() -> str: ...        # importlib.metadata 优先；fallback 读 VERSION（与 cli.py:916 同逻辑）
def plugin_contract_version() -> int: ...     # 读 schemas/superclaw-plugin.schema.json 的 schema_version
def build_version_contract(*, desktop_shell: str | None = None,
                           bundled_core: str | None = None,
                           channel: str | None = None) -> VersionContract: ...
def version_contract_payload(**kw) -> dict:   # asdict + dimensions 列表，CLI/API 共用
    ...
```
不变量：`cli_core == product_version`；所有维度从 `VERSION`/schema 文件派生，**不接受运行期被低层模块覆盖**；`desktop_shell`/`bundled_core` 只能由壳/打包注入（环境变量 `SUPERCLAW_DESKTOP_SHELL_VERSION`、`SUPERCLAW_BUNDLED_CORE_VERSION`），缺失即 `None`（pip 路径）。

#### 1.2 `packages/superclaw/src/superclaw/release_manifest.py`（C1+C2，签名 release manifest 解析+验签）
职责：定义 `superclaw-releases.json` 的强类型解析 + 验签 + 反回滚 + 多维 min-supported 比对。**唯一允许下载授权的判定点**。

```python
@dataclass(frozen=True)
class ReleaseEntry:
    channel: str
    version: str
    sequence: int                 # 单调递增，反回滚（< 本地 watermark 即拒绝）
    download_url: str             # https only
    sha256: str                   # 制品 hash（下载后强制比对）
    signature: str                # ed25519:<b64>，签的是 canonical(entry without signature)
    min_supported_cli_core: str
    min_supported_state_schema: int
    min_supported_api_contract: int
    min_reader_version: int        # 防新写旧读：写过此 state 的最低 reader schema
    released_at: float
    notes: str | None

@dataclass(frozen=True)
class ReleaseManifest:
    schema_version: int            # = 1
    generated_at: float
    sequence: int                  # 顶层 snapshot 序列（反回滚整份 manifest）
    channels: dict[str, ReleaseEntry]

class ReleaseManifestError(Exception): ...        # fail-closed 信号

def verify_release_manifest(raw: dict, *, public_key: str | None = None) -> ReleaseManifest:
    """复用 plugins._verify_signature 的 Ed25519 算法但用 RELEASE 根公钥。
    fail-closed: 缺公钥/签名无效/schema 不符 → 抛 ReleaseManifestError。"""
    ...

def check_update(contract: VersionContract, manifest: ReleaseManifest, *,
                 watermark_sequence: int) -> "UpdateDecision":
    """纯函数：比对当前多维版本 vs channel latest。
    - sequence <= watermark → 拒绝（回滚攻击），update_available=False, blocked_reason='anti_rollback'
    - latest.min_supported_cli_core > contract.cli_core 等不满足 → compatible=False, blocked_reason='min_supported'
    - 否则 update_available = (latest.version != contract.product_version)。"""
    ...

RELEASE_ROOT_PUBLIC_KEY_ENV = "SUPERCLAW_RELEASE_ROOT_PUBLIC_KEY"   # 独立于 plugin 根公钥
```

`UpdateDecision` dataclass：`update_available: bool`, `current: VersionContract`, `latest: ReleaseEntry | None`, `compatible: bool`, `blocked_reason: str | None`（`anti_rollback|signature_invalid|network|min_supported|manifest_missing`）, `download_url|sha256|signature`（仅 compatible 时填）。

**托管/验证位置**：`superclaw-releases.json` 由 CI 发布到固定 HTTPS 端点（与 DMG 同分发渠道，见 docs/macos-dmg-release-standard.md 的 release evidence），客户端缓存进 `.superclaw/registry/`（与方向二 TUF 元数据同目录，但**独立文件、独立根公钥**）。验证只在 core（`verify_release_manifest`），Tauri/API 不自行验。

#### 1.3 `packages/superclaw/src/superclaw/update_orchestrator.py`（C3+C4+C5，core 决策中枢）
职责：把 check / preflight / apply-handoff / migration-state 收成 core 单一入口。**Tauri 和 API 都只调它。**

```python
@dataclass(frozen=True)
class PreflightBlocker:
    kind: str            # active_run|pending_approval|plugin_install|projection_lock|incompatible
    detail: str
    refs: list[str]      # run_id / approval_id / lock_key

@dataclass(frozen=True)
class PreflightResult:
    ok: bool             # True 仅当 blockers 为空
    blockers: list[PreflightBlocker]
    decision: UpdateDecision

def update_check(store, *, manifest_loader, contract, channel) -> UpdateDecision: ...

def update_preflight(store, *, decision: UpdateDecision) -> PreflightResult:
    """HARD-block（fail-closed）：
    1. active run —— store.list_runs() 中任一 effective_run_state(run)['is_live']
       或 effective_status in EXECUTING_RUN_STATUSES/WAITING_FOR_HUMAN_GATE。
    2. pending approval —— store.list_approvals(status='pending') 非空。
    3. plugin install in progress —— 持有 PLUGIN_INSTALL_LOCK_KEY 的 workspace_lock（见 C3 锁）。
    4. projection/checkout lock —— store.list_workspace_locks() 中非 plugin-install 锁非空（团队 checkout 持锁）。
    5. incompatible —— decision.compatible == False 或 decision.blocked_reason 非空（含 network/manifest_missing）。
    任一命中 → ok=False。"""
    ...

def update_prepare_apply(store, *, decision, preflight) -> "ApplyHandoff":
    """只在 preflight.ok 时返回 apply 票据：core 创建 state.db 快照 + 写 staged 标记。
    返回 ApplyHandoff{apply_token, snapshot_path, download_url, sha256, expected_sequence,
                      relaunch_argv}。token 单次消费、绑定 sequence+sha256+nonce+expiry，给 Tauri。"""
    ...

def update_state(store) -> dict:
    """迁移/回滚状态读模型：当前 state_schema、min_reader_version、最近快照、
    上次 apply 结果、是否存在待回滚快照。CLI/API 共用。"""
    ...
```

`PLUGIN_INSTALL_LOCK_KEY = "plugin-install"` —— 新增约定锁；`plugin_cloud.install_plugin_from_cloud_metadata`（plugin_cloud.py:196）入口处 `acquire_workspace_lock(lock_key=PLUGIN_INSTALL_LOCK_KEY, ...)`，finally 释放。preflight 用现有 `list_workspace_locks()` 即可观测（条件 3/4 按 lock_key 区分），无需新表。

#### 1.4 `schemas/superclaw-release.schema.json`（C1）
JSON Schema 2020-12，镜像 1.2 的 `ReleaseManifest`/`ReleaseEntry`。`required`: `schema_version, generated_at, sequence, channels`；每 entry `required`: `channel, version, sequence, download_url, sha256, signature, min_supported_cli_core, min_supported_state_schema, min_supported_api_contract, min_reader_version, released_at`。`download_url` `pattern: "^https://"`；`sha256` `pattern: "^[a-f0-9]{64}$"`；`signature` `pattern: "^ed25519:"`。与现有 `schemas/superclaw-plugin.schema.json` 同目录、同 draft。

#### 1.5 `packages/superclaw/src/superclaw/state_migrations.py`（C4，迁移注册表）
职责：把 state.db 从"无版本号"升级为 `PRAGMA user_version` 驱动的有序迁移 + backup-before-apply。

```python
SCHEMA_VERSION = 1   # 当前 schema 的目标版本（首次落地把现有结构记为 v1）

@dataclass(frozen=True)
class Migration:
    to_version: int
    description: str
    apply: Callable[[sqlite3.Connection], None]

MIGRATIONS: list[Migration] = [
    # v0->v1: 把现有 CREATE TABLE IF NOT EXISTS 全集 + chat_sessions.workspace_id
    #         列迁移收编为受版本管控的 baseline（幂等，已存在则 no-op；缺索引/列则补齐）。
]

class StateMigrationError(Exception): ...
class StateSchemaTooNewError(Exception): ...

def current_schema_version(conn) -> int:       # PRAGMA user_version
def backup_state_db(path: Path) -> Path:        # 复制到 <path>.bak-<schema>-<ts>，apply 前调用
def run_migrations(conn, *, db_path: Path) -> dict:
    """boot-time：读 user_version → 若 < SCHEMA_VERSION：先 backup_state_db，
    在单事务内按序 apply 每个 Migration，成功后 PRAGMA user_version = to_version。
    任一步失败 → 回滚事务 + 保留 backup + 抛 StateMigrationError（fail-closed，不在旧 schema 上裸跑）。
    若 user_version > SCHEMA_VERSION（旧 reader 读新库）→ 抛 StateSchemaTooNewError 提示升级。"""
    MIN_READER_VERSION = SCHEMA_VERSION
```

#### 1.6 测试文件（新建）
- `tests/test_version_contract.py`、`tests/test_release_manifest.py`、`tests/test_update_orchestrator.py`、`tests/test_state_migrations.py`、`tests/test_cli_version_update.py`、`tests/test_api_version_update.py`。

---

### 2. 改动的现有文件（含 file:line 锚点 + 行为保持/back-compat）

#### 2.1 `packages/superclaw/src/superclaw/cli.py`
- **cli.py:916 `_superclaw_version()`**：保留（back-compat），内部改为 `return version_contract.read_product_version()`（行为等价）。
- **新增顶层命令 `superclaw version`**（当前不存在，确认无冲突），放在 `doctor`（cli.py:1617）附近：
  ```python
  @app.command()
  def version(json_output: bool = typer.Option(False, "--json")) -> None:
      payload = version_contract.version_contract_payload()
      if json_output: typer.echo(json.dumps(payload, sort_keys=True)); return
      # 人读多行：product / cli_core / api_contract / state_schema / plugin_contract / channel
  ```
- **新增 `update_app = typer.Typer(...)` + `app.add_typer(update_app, name="update")`**（仿 cli.py:206-222 的 sub-app 模式），三子命令：`update check --json [--channel beta]`、`update preflight --json`（非 0 退出码当 `ok=False`）、`update state --json`。（C5 内核侧到此；`update apply` 的 OS 替换属 Tauri，core 只提供 `update prepare-apply`，C6 接线。）
- **doctor（cli.py:1618）补两行**：`state_schema=...`、`release_root_key: set/unset` —— 与现有 doctor 输出风格一致。

#### 2.2 `packages/superclaw/src/superclaw/state.py`
- **state.py:67 `_init()`**：在 `executescript(...)`（结束于 :255）与 `_migrate_chat_sessions_workspace_column`（:256）之后，新增 boot-time 迁移钩子 `state_migrations.run_migrations(conn, db_path=self.path)`。
- **back-compat**：v0→v1 baseline 把现有 `CREATE TABLE IF NOT EXISTS` 全集 + `workspace_id` 列迁移视为幂等 no-op；首次开旧库 `user_version=0`，迁移成功后置 1，**现有数据零丢失**（只在缺列/缺索引时 ADD/CREATE，从不 DROP/重写既有表）。`_migrate_chat_sessions_workspace_column`（:267）保留共存。
- 不改 `_connect()`（:57）签名。

#### 2.3 `plugin_proxy.py:59`、`apps/api/main.py:1444/:770/:1760`、版本镜像四处
- `plugin_proxy.py:59 DEFAULT_RUNTIME_VERSION`：保留常量（被 4 处引用，承载 plugin policy 版本语义，是 plugin_contract 维度，独立演进），仅补注释指向 `version_contract` 为权威，不强制替换（避免 plugin policy 回归）。
- `apps/api/main.py:1444 FastAPI(version="0.1.0")` 改为读 `version_contract.read_product_version()`；`:770`、`:1760` 硬编码 `"0.1.0"` 同步改读 `version_contract`。
- `pyproject.toml:3`、`VERSION`、`tauri.conf.json:4`、`Cargo.toml:3`：**不手改值**——C1 加 `scripts/sync_versions.py` 做 CI 一致性闸门（读 `VERSION`，断言其余四处一致），保持"VERSION 单一事实源、其余派生镜像"。

#### 2.4 `apps/api/main.py`（新增端点，包装 core，零并行实现）
在 `health()`（main.py:2032）附近、按 `Depends(require_control_token)` 注册：`GET /api/version`、`GET /api/update/check`、`GET /api/update/preflight`（`ok=False` 仍 200，payload 拒绝，HTTP 层不放行）、`GET /api/update/state`。`POST /api/update/prepare-apply`（C6 接 Tauri，本规格只声明形状：仅 `preflight.ok` 才返回 `ApplyHandoff`，否则 409 + blockers）。

#### 2.5 `apps/desktop/src-tauri/src/lib.rs`（C6，本规格只标钩子不实现 OS 替换）
- `DesktopShellInfo`（lib.rs:30-43）已含 `version/release_channel/update_mode`。C6 新增 Tauri command `desktop_update_apply(handoff)`：仅在收到 core 签发 `apply_token` 后执行 `download→sha256 校验→替换 .app→relaunch`。**Rust 不做任何 check/验签/preflight 决策**——全部 `invoke_cli_json(["update","check"|"preflight"])` 回 core（复用 lib.rs:965）。`DEFAULT_UPDATE_MODE`（lib.rs:15）从 `"manual"` 改 channel 驱动属 C6。

---

### 3. 数据结构/Schema 汇总
（dataclass 见 §1；JSON Schema 见 §1.4）

`version --json` 输出（CLI 与 `/api/version` 逐字节一致）：
```json
{"product_version":"0.1.0","cli_core":"0.1.0","bundled_core":null,"desktop_shell":null,
 "api_contract":1,"state_schema":1,"plugin_contract":1,"projection_schema":1,
 "git_sha":null,"channel":"beta",
 "dimensions":["desktop_shell","bundled_core","cli_core","api_contract","state_schema","plugin_contract","projection_schema"]}
```
`update preflight --json`：
```json
{"ok":false,
 "blockers":[{"kind":"active_run","detail":"run is live","refs":["run_abc"]},
             {"kind":"pending_approval","detail":"1 pending approval","refs":["appr_x"]}],
 "decision":{"update_available":true,"compatible":true,"blocked_reason":null,
             "latest":{"version":"0.2.0","sequence":7,"sha256":"...","channel":"beta"}}}
```

---

### 4. CLI 命令（事实源）
- `superclaw version [--json]` —— 多维版本契约。
- `superclaw update check [--json] [--channel <c>]` —— 验签 manifest + 反回滚 + 多维兼容比对。
- `superclaw update preflight [--json]` —— HARD-block 检查；`ok=False` 时退出码非 0。
- `superclaw update state [--json]` —— 迁移/回滚/快照状态。
- （C6）`superclaw update prepare-apply` —— 签发 apply 票据给 Tauri；本规格只占位。

CLI 经 `invoke_cli_json`（lib.rs:965 现成通道）被 Tauri 调用，保证桌面/CLI 走同一份 core 判定。

---

### 5. API 端点（全部包装同一 core）
| Method | Path | core 调用 | 鉴权 |
|---|---|---|---|
| GET | `/api/version` | `version_contract.version_contract_payload()` | `require_control_token` |
| GET | `/api/update/check` | `update_orchestrator.update_check(...)` | 同上 |
| GET | `/api/update/preflight` | `update_orchestrator.update_preflight(store, ...)` | 同上 |
| GET | `/api/update/state` | `update_orchestrator.update_state(store)` | 同上 |
| POST | `/api/update/prepare-apply`（C6）| `update_prepare_apply(...)`，仅 preflight.ok | 同上，否则 409 |

---

### 6. ui_contracts.py 新增（共享投影，防表层硬编码）
在 imports 区（ui_contracts.py:1-26）`from superclaw import version_contract, update_orchestrator`，并加（与 `build_runtime_status_payload` :944 同风格）：
- `build_version_contract_payload() -> dict` —— surfaces 渲染版本/维度的**唯一**来源（Settings 版本卡片不得自拼 `0.1.0`）。
- `build_update_status_payload(store, *, manifest_loader) -> dict` —— 合成 `{update_available, compatible, blocked_reason, blockers[], channel, latest_version, can_apply}`，`can_apply = decision.update_available and decision.compatible and preflight.ok`（**判定在 core，surface 只读 `can_apply`**）。
- `build_runtime_status_payload`（:944）的 `service` 块补 `"version_contract": build_version_contract_payload()`（back-compat：`runtime_version` 字段保留）。
- `RELEASE_CHANNEL_OPTIONS = ("stable","beta","dev")` 供 surface 渲染 channel 选择。

---

### 7. 原子 PR 拆分见 pr_breakdown 字段（C1…C5），C6+ 属 P6 表层不在本规格实现。

---

### 8. fail-closed / 治理红线核对
1. **决策独占于 core**：check/验签/preflight/migration 全在 Python；Tauri 只 `invoke_cli_json` 回 core + 拿 core 单次 `apply_token` 后做纯 OS 替换；API 只 `Depends(require_control_token)` 包装。CLI(pip) 与桌面共用同一 `version_contract`/`release_manifest`，**不存在两套更新治理**（直击顾问阻断点）。
2. **网络/签名/序列/TTL 失败一律拒绝**：`verify_release_manifest` 缺公钥/坏签名抛错；`check_update` 对降序 sequence、`min_supported_*` 不满足、manifest 缺失全部置 `blocked_reason` 且 `compatible=False`，`can_apply` 恒 False。
3. **preflight 硬阻断不可被表层绕过**：`/api/update/preflight` `ok=False` 仍 200 但 payload 拒绝；`prepare-apply` 在 `ok=False` 时 409；CLI `update preflight` 退出码非 0。判活复用 `liveness.effective_run_state`（唯一定义点），不信存储 status 字符串。
4. **迁移 fail-closed**：boot 时 `user_version < SCHEMA_VERSION` 必先 backup 再事务内迁移，失败回滚保 backup；`> SCHEMA_VERSION` 直接拒启（防新写旧读 + release `min_reader_version`）。
5. **域隔离**：release 根公钥独立于 plugin 根公钥；release schema 独立文件；版本维度独立演进（北极星护栏 1 的"信任原语可共享、域模型平行"）。

---

### 9. back-compat / 迁移
- `_superclaw_version()`（cli.py:916）签名/返回保持；`runtime status` 的 `runtime_version` 保留，版本契约**追加**进 `service.version_contract`。
- state.db v0→v1 baseline 幂等、零数据丢失；`_migrate_chat_sessions_workspace_column`（:267）共存；首次升级自动 backup 可回滚。
- `DEFAULT_RUNTIME_VERSION`（plugin_proxy.py:59）保留（4 处引用 + plugin policy 语义），仅注释指向新权威。
- 手动更新路径（docs/desktop-manual-update.md）继续有效；本方向**叠加** core-governed 自动通道，不删手动路径（pip 与桌面整包替换并存）。
- `tauri.conf.json` 无 updater 段不动（C6 才加）；`DEFAULT_UPDATE_MODE="manual"` 保持到 C6。

---

### 10. 给 Codex/Gemini 的对抗性 stress-test 点（见 open_questions）


### 原子 PR 拆分（汇总表）

| PR | 范围 | 验收标准 | 依赖 |
|---|---|---|---|
| feat(version): multi-dimension version contract + signed release manifest format (internal-only) | new packages/superclaw/src/superclaw/version_contract.py, release_manifest.py, schemas/superclaw-release.schema.json, scripts/sync_versions.py (CI version-consistency gate); edit cli.py:916 _superclaw_version, apps/api/main.py:1444/:770/:1760 to read version_contract. No UI, no update commands, no download verification (format definition + parse/validate only). Tests: tests/test_version_contract.py, tests/test_release_manifest.py. | `superclaw version --json` emits all 7 dimensions (product/cli_core/bundled_core/desktop_shell/api_contract/state_schema/plugin_contract + channel + dimensions[]); verify_release_manifest fails closed (ReleaseManifestError) on tampered signature/missing key/schema mismatch; check_update returns blocked_reason=anti_rollback when sequence<=watermark; sync_versions.py exits non-zero when VERSION disagrees with tauri.conf.json/Cargo.toml/pyproject/api mirrors. | none |
| feat(update): release manifest signature verification + anti-rollback watermark | release_manifest.py wires _verify_signature (reuse plugins.py:351 Ed25519, independent SUPERCLAW_RELEASE_ROOT_PUBLIC_KEY env); .superclaw/registry/release-watermark.json persistence; check_update pure function with min_supported_* matrix compare. Tests: tests/test_release_manifest.py (extended: verify + watermark persistence + fail-closed branches). | valid signature + advancing sequence => update_available=True; invalid signature / descending sequence / missing root key => fail-closed with matching blocked_reason; no-network / missing manifest => blocked_reason=network\|manifest_missing, never silently allows. | C1 |
| feat(update): update orchestrator preflight HARD-blocks (active runs / approvals / plugin install / projection lock) | new update_orchestrator.py (check/preflight/state, apply-handoff stub); plugin_cloud.py:196 acquires PLUGIN_INSTALL_LOCK_KEY workspace_lock around install (finally release). Preflight reuses liveness.effective_run_state (liveness.py:67) + state.list_runs/list_approvals/list_workspace_locks; no new liveness logic. Tests: tests/test_update_orchestrator.py. | injecting a live run / pending approval / plugin-install lock / a non-plugin workspace_lock => preflight.ok=False with matching blocker.kind; all clear + compatible decision => ok=True; network/manifest-missing decision => ok=False; `update preflight` exit code flips with ok. | C2 |
| feat(state): PRAGMA user_version migration registry + backup-before-apply + min_reader_version | new state_migrations.py (SCHEMA_VERSION=1, MIGRATIONS, run_migrations, backup_state_db, StateMigrationError/StateSchemaTooNewError); state.py:_init (after line 256) wires boot-time migration. v0->v1 baseline absorbs existing CREATE TABLE set + chat_sessions.workspace_id migration idempotently (ADD/CREATE only, never DROP). Tests: tests/test_state_migrations.py run with clean process / PYTHONDONTWRITEBYTECODE=1 (pyc-mtime memory). | opening an old db (user_version=0) migrates to 1, generates .bak snapshot, preserves all goals/runs/chat_sessions data; mid-migration error => transaction rollback + retained backup + StateMigrationError (no run on old schema); user_version>SCHEMA_VERSION => StateSchemaTooNewError (new-write-old-read guard). | C1 |
| feat(cli,api): version & update commands + endpoints + ui_contracts projections | cli.py adds top-level `version` command + `update` sub-app (check/preflight/state) + 2 doctor lines; apps/api/main.py adds /api/version + /api/update/{check,preflight,state}; ui_contracts.py adds build_version_contract_payload/build_update_status_payload/RELEASE_CHANNEL_OPTIONS and extends build_runtime_status_payload service block. Tests: tests/test_cli_version_update.py, tests/test_api_version_update.py. | CLI `version --json` byte-identical to /api/version; CLI `update preflight --json` same shape + same verdict as /api/update/preflight (single core path); ui_contracts can_apply computed only in core and not overridable by surfaces; /api/update/preflight returns 200 with ok=False rather than HTTP-allowing. | C3, C4 |



### 待评审的开放问题

- apply_token 防重放：ApplyHandoff token 绑定 sequence+sha256+expiry+nonce 单次消费，是否足以挡住 'preflight 通过→拿 token→起新 run→token 仍有效→在 active run 上替换 .app' 的 TOCTOU？apply 前是否需要二次 preflight（类似方向四 resume 的二次 policy check）？
- state_schema 与 release min_supported_state_schema 的耦合：新 .app 需要 schema v2，但首启迁移失败回滚到 v1 快照——新壳/新 bundled_core 跑 v1 schema 是否产生 shell↔bundled_core↔state_schema 三角不一致？是否需要 '迁移失败→阻止新 backend 启动并提示重装旧 .app' 闭环？
- PLUGIN_INSTALL_LOCK_KEY 复用 workspace_locks 表是否语义污染：preflight 用 list_workspace_locks() 统一观测并按 lock_key 区分 plugin-install vs team checkout——这种 '靠约定锁名区分语义' 是否够健壮？是否该用独立锁表/锁命名空间避免误报？
- 反回滚 watermark 落本地 .superclaw/registry/release-watermark.json 可被删/降绕过 anti-rollback——是否该落进 state.db（受 schema 保护）或绑进签名 manifest 的 snapshot 序列，而不是裸文件？
- CLI(pip) `pip install -U` 与桌面整包替换共用 version_contract，但 pip 路径 bundled_core/desktop_shell=None——min_supported_* 比对在 pip 路径是否误判（拿桌面维度去比 pip 安装）？check 是否应按安装形态（pip vs bundled）分流 channel/制品？
- v0->v1 baseline 把现有 CREATE TABLE 全集记为 v1 是否安全：老用户库可能有路线图前的历史脏数据（参见 memory chat-fail-persistence：RunSession.from_dict 对坏 run 数据崩）。baseline 只 ADD/CREATE 不重写，但若历史库缺某个本应在 v1 的索引/列，幂等 CREATE IF NOT EXISTS 能否补齐？是否需在 v1 迁移里显式对齐而非依赖 IF NOT EXISTS？
- release 验签复用 plugins.py 的 Ed25519 算法但用独立根公钥——是否需要委派密钥（多签/轮换）而非单一 release 根公钥？与方向二的 TUF root/targets 是否应共享一套根信任还是严格分离（release 是 app 二进制，plugin 是挂件，语义不同）？

### 已识别风险

- state.py 当前完全无 PRAGMA user_version 机制（只有 CREATE TABLE IF NOT EXISTS + 一次性列迁移 state.py:267）；引入版本化迁移是侵入式改动，若 v0->v1 baseline 处理不当会损坏现存 goals/runs/chat_sessions/company_secrets 等 25+ 张表的真实用户数据。必须 backup-before-apply + 干净进程测试（pyc-mtime 陷阱）。
- 版本号散落 6 处（VERSION/pyproject:3/tauri.conf:4/Cargo:3/DEFAULT_RUNTIME_VERSION/FastAPI version=0.1.0 及 main.py:770/:1760）——只改部分会留下静默不一致；sync_versions.py CI 闸门必须覆盖全部镜像，否则桌面壳与 core 版本漂移、release manifest 的 min_supported 比对失真。
- PLUGIN_INSTALL_LOCK_KEY 复用 workspace_locks 表把 plugin-install 与 team checkout 两种语义混进同一表，preflight 统一用 list_workspace_locks() 观测可能互相误报——需评估是否独立锁命名空间。
- release 验签复用 plugins.py 的 Ed25519 _verify_signature 但必须用独立根公钥 SUPERCLAW_RELEASE_ROOT_PUBLIC_KEY；若误用 plugin 根公钥即跨域信任污染（违反北极星护栏 1 域隔离）。
- Tauri 整包替换是 OS 级破坏性操作；apply_token 单次消费 + apply 前二次 preflight 若缺失，存在 active run 进行中被替换导致数据/证据丢失的风险（属 C6，但 C3 的 handoff 契约必须先把 token 绑定 sequence+sha256+nonce+expiry 设计对）。
- 反回滚 watermark 落本地文件可被篡改绕过 anti-rollback——存储信任边界需在评审前定清，否则 sequence 反回滚形同虚设。
- /api/version 与 CLI version --json 要求逐字节一致，但两者可能跑在不同进程/安装形态（API 可能是冻结 bundled_core，CLI 是 pip），bundled_core/desktop_shell 维度不同会导致 '逐字节一致' 断言在混合安装下假阳性；测试需明确同一进程内比对。


---


## 4. 方向四　提权/问询交互弹窗（统一传输、授权硬隔离）

**落地概述**：方向四 — 提权/问询交互弹窗（two-layer: 统一传输/呈现 + 授权硬隔离）。建一个共享 `EscalationEnvelope` 信封 + durable `escalations` 表，承载生命周期/展示字段；底下挂 6 个**独立的、强类型的决策记录**（PermissionEscalation / GovernanceGate / RuntimeToolApproval / PlanApproval / ClarifyingQuestion / IssueCompletionReview），每类有**自己的 handler**，respond 端点按内核物化的 `kind` 强类型路由，绝不复用一套授权逻辑。P0 先收紧 `interactive=False` 的"按 policy 自动应答"为 fail-closed（需要人审的动作不再静默替用户决定，改为物化 escalation + 挂起 runtime），并补 `superclaw escalation list/show/respond` CLI。resume 票据是内核生成的 AES-GCM 加密、单次消费、二次 policy check 的票据。三套现有系统（governance-approvals / team_kernel Approval / human-gate）只统一**传输/呈现**（一套 SSE + 一个弹窗 + 一个 respond 入口），**授权 handler 不合并**。SSE 只是通知，权威永远是 durable store + CLI/REST snapshot。构建顺序：D1（fail-closed 收紧 + store + 加密票据 + CLI，先于一切 UI）→ D2（REST + SSE）→ D3（Web 通用弹窗 + pending 徽章）→ D4（迁移 3 套现有系统共享信封）→ D5（拦截 Codex/Claude 原生 approval 回调进统一通道）。


# 方向四实施规范 — 提权 / 问询交互弹窗（统一升迁通道，授权硬隔离）

> 北极星合规：本方向严格贯彻路线图 §0 五条护栏 —— **统一只到"信封 / 传输 / 展示"，绝不统一到"授权 / 决策"**（§2 方向四裁决）。`EscalationEnvelope` 是唯一被六类记录共享的东西；六类决策记录是平行强类型实体，各走各的 handler，绝不出现 `if kind == 'governance': skip_policy()` 这类污染。内核（Python core/CLI）独占决策权，REST/SSE/Web 只投影 durable store。SSE 只是通知，权威永远是 store + CLI/REST snapshot（§0 护栏 3）。fail-closed 是默认（§0 护栏 4）。

---

## 0. 现状锚点（已用代码核实）

| 事实 | 位置 |
|---|---|
| 两态 preset，`interactive=False` 处处如此 | `permissions.py:28`（`PermissionPreset`）、`:45-48`（`PRESET_TO_MODE`），`PresetRealization.interactive` 注释 `:62-66` 明言"今天处处 False，连 Codex app-server approval 回调都被 policy 自动应答" |
| B 类 in-process tool 唯一 posture 门 | `backends.py:2798-2808`（`_exec_tool`：`posture_for_mode`→`posture_denies_tool`，只在 `mode=plan`/readonly 拒 mutating，**其余模式静默执行**） |
| Codex app-server 原生 approval 被自动应答 | `codex_app_server.py:616-649`（`_handle_server_request`：commandExecution/fileChange/permissions/elicitation 全部按 `self.approval_decision` 自动 accept/decline，**无人参与**）；决策来源 `backends.py:1156-1164`（`_approval_decision_for_policy`） |
| API direct-chat 同一 mapping 自动应答 | `apps/api/main.py:1079-1140`（permission_mode → sandbox/approval_policy/`CodexApprovalDecision`，注释明言"the SAME mapping the kernel CodexAppServerBackend uses"） |
| TeamKernel `Approval` 记录（已存在） | `models.py:1187-1216`（`type`/`status`/`issue_id`/`requested_permission`/`affects`/`resume_action`），`ApprovalType` `models.py:1040-1043`（`ISSUE_COMPLETION`/`PERMISSION_GRANT`/`BUDGET_OVERRIDE`），状态机 `models.py:1015-1037` |
| `decide_approval` / `submit_for_review` | `team_kernel.py:694-734`（submit）、`:737-909`（decide，含 issue 状态翻转 + 锁释放 + 唤醒续作） |
| durable approvals 表 + 持久化 | `state.py:117-122`（`approvals` 表）、`save_approval` `:1147-1168`、`get_approval` `:1170-1177`、`list_approvals` `:1179-1211`、`apply_approval_decision` `:1383` |
| 事件总线 / 增量 SSE | `state.py:515-521`（`add_event`+`_notify_event_bus`）、`list_events_after` `:536-555` |
| 治理 approvals 收件箱（JSON 文件，**割裂**） | `apps/api/main.py:2069-2112`（`governance-approvals.json`，POST/GET `/api/governance/approvals`） |
| human-gate（只改 run 状态，**无记录**） | `apps/api/main.py:4462-4472`（`/api/runs/{id}/human-gate`，仅 `WAITING_FOR_HUMAN_GATE` + `run.paused` 事件） |
| team approvals REST | `apps/api/main.py:5085-5095`（list）、`:5455-5473`（grant/reject → `team_kernel.decide_approval`） |
| 治理硬门（scan/pay） | `fusion.py:22`（`HumanGateRequired`）、`:288-294/315/373/462`（`gate="human_gate"/"operator_control"`），`fusion.py:966`（`decision in {approved,...}`） |
| CLI typer 组织 + approve 子命令 | `cli.py:183-219`（typer app 注册）、`:4816-4871`（`approve list/show/grant/reject`）、`_team_store` `:4034` |
| ui_contracts 契约入口 | `ui_contracts.py:311`（`build_permission_mode_contract`）、`:1072`（`build_approval_queue_payload`），`permission_mode_contract` 在 `permissions.py:153-159` |
| Web 权限 preset + SSE 监听 | `App.tsx:3041-3048`（`permissionPreset`）、`:6221-6285`（run events SSE，`watched` 列表 `:6234-6257`）；team 审批 UI `TeamWorkbench.tsx:813-848` |
| 加密原语可复用 | `secrets_store.py:153-178`（AES-GCM `_encrypt`/`_decrypt`，`load_master_key` `:104-129`，0600 key 文件，`_pysecrets.token_bytes`） |

**核心判断**：审批原语（`Approval` + durable 表 + 状态机 + 事件总线 + AES-GCM）都已存在。本方向是 **(a) 把"自动应答"收紧成 fail-closed、(b) 抽一层公共信封统一传输/呈现、(c) 在信封下挂 6 类强类型独立 handler、(d) 加密单次票据**，而非从零造。

---

## 1. 新建模块 / 文件

### 1.1 `packages/superclaw/src/superclaw/escalation.py`（新，核心内核）

职责：`EscalationEnvelope` + 六类强类型决策记录 + **kind→handler 注册表（强类型路由）** + 物化/解析的纯领域逻辑（不碰 SQLite、不碰 HTTP）。

```python
# --- 公共生命周期 / 展示信封（唯一共享物）---------------------------------
class EscalationKind(str, Enum):
    PERMISSION = "permission_escalation"      # B 类 in-process / claude posture 提权
    GOVERNANCE = "governance_gate"            # pay / scan 治理硬门（fusion）
    RUNTIME_TOOL = "runtime_tool_approval"    # Codex/Claude 原生 approval 回调归一化
    PLAN = "plan_approval"                    # 方向五 PlanApproval（占位，本期不实现 handler）
    CLARIFY = "clarifying_question"           # 业务问询（自由文本/选项）
    ISSUE_COMPLETION = "issue_completion_review"  # QA 审批（接 team_kernel.Approval）

class EscalationStatus(str, Enum):
    PENDING = "pending"; RESOLVED = "resolved"; EXPIRED = "expired"; CANCELLED = "cancelled"

@dataclass(frozen=True)
class EscalationOption:
    id: str          # 稳定选项 id（票据绑定它，不绑 label）
    label: str
    style: Literal["primary", "default", "danger"] = "default"
    free_text: bool = False   # CLARIFY 才可为 True（允许文本输入）

@dataclass
class EscalationEnvelope:
    """公共生命周期 + 纯展示字段。NO authorization semantics here."""
    kind: str                                 # EscalationKind 值
    prompt_text: str
    request_id: str = field(default_factory=lambda: _id("esc"))
    run_id: str | None = None
    session_id: str | None = None
    company_profile_id: str | None = None
    workspace_id: str | None = None
    options: list[dict] = field(default_factory=list)   # EscalationOption.to_dict()
    default_option_id: str | None = None
    timeout_seconds: int | None = None         # None = 不超时；过期 -> EXPIRED（fail-closed）
    status: str = EscalationStatus.PENDING.value
    created_at: float = field(default_factory=time)
    resolved_at: float | None = None
    decided_option_id: str | None = None
    decided_free_text: str | None = None
    decided_by: str | None = None
    # 决策记录指针：强类型 payload 落在 detail，按 kind 反序列化
    detail: dict = field(default_factory=dict)
    # 加密票据指纹（ticket 全文不落库，只存 nonce + 指纹做单次消费校验）
    ticket_nonce: str | None = None
    ticket_sha256: str | None = None
    ticket_consumed: bool = False
    def to_dict(self) -> dict: ...
    @classmethod
    def from_dict(cls, data) -> "EscalationEnvelope": ...   # 同 Approval.from_dict 过滤未知字段
```

**六类决策记录（独立 dataclass，存进 `envelope.detail`，各自校验语义不同）**：

```python
@dataclass(frozen=True)
class PermissionEscalation:   # B 类 / claude posture 提权
    tool_name: str; requested_mode: str; current_mode: str; reason: str
@dataclass(frozen=True)
class GovernanceGate:         # pay / scan 硬门 —— 即使用户点"允许"，仍需已批准权限
    intent: str; tool: str; command_redacted: str; source: str
    requires_approved_entitlement: bool = True   # 永远 True for pay/scan
@dataclass(frozen=True)
class RuntimeToolApproval:    # Codex/Claude 原生回调归一化
    runtime: str; native_method: str; tool: str; diff_or_command_redacted: str
@dataclass(frozen=True)
class PlanApproval:           # 方向五占位（本期不接 handler）
    plan_summary: str; milestones: list[str]
@dataclass(frozen=True)
class ClarifyingQuestion:     # 业务问询（无授权语义）
    question: str; allow_free_text: bool = True
@dataclass(frozen=True)
class IssueCompletionReview:  # QA 审批 -> team_kernel.Approval
    approval_id: str; issue_id: str; summary: str
```

**强类型路由表 + handler 协议**（关键：respond 端点**不内联** if/elif 决策，而是查注册表；每类 handler 独立模块函数，授权逻辑物理分离）：

```python
class EscalationDecision(TypedDict):
    status: str             # "resolved"
    applied: dict           # handler-specific 副作用快照
    grant: bool             # 该 kind 解释下用户是否"批准"

EscalationHandler = Callable[[StateStore, EscalationEnvelope, "ResolveContext"], EscalationDecision]

_HANDLERS: dict[str, EscalationHandler] = {}   # kind -> handler；缺失 = fail-closed 拒绝

def register_handler(kind: EscalationKind, fn: EscalationHandler) -> None: ...
def handler_for(kind: str) -> EscalationHandler:
    fn = _HANDLERS.get(kind)
    if fn is None:
        raise EscalationDenied(f"no handler for kind {kind!r}")   # fail-closed
    return fn

@dataclass(frozen=True)
class ResolveContext:
    decided_by: str
    decided_option_id: str
    decided_free_text: str | None
    policy_snapshot: dict        # 来自票据，二次 policy check 用
    ticket_verified: bool        # 票据已验签 + 单次消费成功
```

每个 handler 的授权语义**独立**（示意）：
- `handle_permission(...)`：只解释 ask/allow posture 的"是否放行该 tool 一次"；resume 时**重新跑** `posture_for_mode` 二次校验当前 mode 仍允许，否则即便用户点允许也拒。
- `handle_governance(...)`：**必须**调 `fusion`/entitlement 模块校验"已批准权限 + 已批准 high-risk"；用户点"允许"≠放行 —— 无已批准 entitlement 时**保持阻断**并把 envelope 标 resolved+grant=False（§2 方向四"即使用户点允许，pay 意图无已批准权限 + 人审仍由内核保持阻断"）。
- `handle_runtime_tool(...)`：把用户决定回送给挂起的 runtime（D5 接 `codex_app_server`），不破坏 sandbox 语义。
- `handle_clarify(...)`：纯业务 —— 把 free_text/option 写回会话上下文，**无授权副作用**。
- `handle_issue_completion(...)`：委托 `team_kernel.decide_approval(store, approval_id, approved=...)`（**复用现成 handler，不重写**）。

### 1.2 `packages/superclaw/src/superclaw/escalation_ticket.py`（新，加密单次票据）

职责：生成/验证 resume 票据。复用 `secrets_store.load_master_key()` 的 AES-GCM 主密钥（同一 0600 key 文件，`secrets_store.py:104-129`），**绝不**自造密钥管理。

```python
TICKET_SCHEME = "escalation-ticket-v1"
TICKET_AAD = b"superclaw.escalation.ticket"   # AES-GCM additional authenticated data 防类型混淆

@dataclass(frozen=True)
class TicketClaims:
    request_id: str
    kind: str                       # 绑定 kind —— 票据不能跨类型重放
    principal: str                  # 谁被授权应答（decided_by 必须 == 此）
    policy_snapshot: dict           # 物化时的 mode/preset/company/workspace，resume 二次校验
    requested_action: dict          # 强类型决策记录快照（哈希进 payload）
    allowed_option_ids: list[str]   # 合法选项白名单 —— respond 的 option 必须 ∈ 此
    run_state_fingerprint: str      # 物化时 run/session 状态指纹，resume 时比对（状态漂移 -> 拒）
    nonce: str                      # token_bytes(16) hex —— 单次消费键
    expiry: float                   # created + timeout；过期 fail-closed

def issue_ticket(claims: TicketClaims) -> str:
    """AES-GCM 封 JSON(claims)，返回 base64 token；iv 随机，AAD=TICKET_AAD。"""
def verify_ticket(token: str) -> TicketClaims:
    """解密 + 校验 scheme/expiry。解密失败/篡改/过期 -> raise TicketError（fail-closed）。"""
def ticket_fingerprint(token: str) -> tuple[str, str]:
    """返回 (nonce, sha256(token))，物化时存进 envelope 供单次消费比对。"""
```

**防重放/防伪造（对照 §2 方向四要求）**：
1. **加密签发**：token 由内核 AES-GCM 封装（机密性 + 完整性 GCM tag），客户端无法伪造或篡改。
2. **绑定七要素**：`principal + policy_snapshot + requested_action + allowed_option_ids + run_state_fingerprint + nonce + expiry`（精确对齐路线图列举）。
3. **单次消费**：respond 时在**同一 SQLite 事务**内 `UPDATE escalations SET ticket_consumed=1 WHERE request_id=? AND ticket_consumed=0`，受影响行数 0 → 已被消费 → 拒（防并发双花）。
4. **二次 policy check**：`verify_ticket` 通过后，handler 仍用**当前** store 状态重算 policy（如 `posture_for_mode`、entitlement），票据里的 `policy_snapshot` 只用于检测"物化后策略被收紧"，不作为放行依据。
5. **kind 绑定 + AAD**：票据封 `kind`，且用 `TICKET_AAD` 做 GCM AAD —— 治理票据无法被当作问询票据消费（堵住路线图点名的"高危治理请求伪造成低权限问询"漏洞）。
6. **option 白名单 + free_text 闸**：respond 的 `option_id` 必须 ∈ `allowed_option_ids`；`free_text` 仅当对应 option `free_text=True` 才接受。
7. **过期 fail-closed**：`expiry` 过 → `EXPIRED`，不可应答。

### 1.3 测试文件（随各 PR）：`tests/test_escalation_kernel.py`、`tests/test_escalation_ticket.py`、`tests/test_escalation_failclosed.py`、`tests/test_escalation_store.py`、`tests/test_api_escalations.py`、`tests/test_escalation_migration.py`、`tests/test_escalation_runtime_normalize.py`；`apps/web/tests/escalation-popup.test.tsx`、`apps/web/tests/team-approval-envelope.test.tsx`。

---

## 2. 改动的现有文件（file:line 锚点）

### 2.1 `permissions.py` — P0 收紧 + 提权探针（保持 back-compat）
- **`:45-48` `PRESET_TO_MODE`**：保持不变（`ask→acceptEdits` / `allow→bypassPermissions`），back-compat。
- **`:131-137` `posture_for_mode`**：**保持现签名**，新增伴随谓词判定"何时需人审而非静默决定"：
  ```python
  def action_requires_human(mode: str | None, tool_name: str) -> bool:
      """True when, under this mode, a HUMAN must decide instead of auto-answer.
      ask(acceptEdits): mutating shell (run_shell) requires human; edits auto.
      allow(bypass): nothing requires human (explicit allow-all)."""
      if mode in {"bypassPermissions", "dontAsk"}:
          return False
      if mode == "plan":            # readonly: 仍由 posture_denies_tool 直接拒，不升迁
          return False
      return tool_name in _MUTATING_TOOLS   # acceptEdits/default: run_shell -> 见 §8
  ```
  说明：`ask` 语义本就是"自动批 edits + plugin/MCP，不自动跑 shell"（`permissions.py:42-44` 注释）。今天 `_exec_tool` 在 ask 下**仍静默跑 shell**（`backends.py:2810`），这正是 fail-closed 缺口。新谓词只把 `run_shell` 标"需人审"，`write_file` 保持 acceptEdits 自动（§8/§10 取舍）。
- **新增 `escalation_mode_contract()`**：导出 `kinds`/`statuses`/`option_styles` 枚举给 surfaces（§6）。

### 2.2 `models.py` — 复用，无破坏
- `Approval`（`:1187-1216`）、`ApprovalType`（`:1040-1043`）、状态机（`:1015-1037`）**全部保留**。`IssueCompletionReview` handler 直接复用它们。新增枚举值放 `escalation.py`，不污染 `models.py`。

### 2.3 `state.py` — 新增 `escalations` 表 + CRUD + 单次消费事务
- **`:117-122` 之后**新增表（紧邻 `approvals`，共享 workspace 生命周期）：
  ```sql
  CREATE TABLE IF NOT EXISTS escalations (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT, session_id TEXT,
      company_profile_id TEXT, workspace_id TEXT,
      ticket_nonce TEXT, ticket_consumed INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      payload TEXT NOT NULL
  );
  ```
- 新增方法（镜像 `save_approval`/`list_approvals` 风格，`:1147-1211`）：
  - `save_escalation(env) -> EscalationEnvelope`：`INSERT OR REPLACE`，status 用与 approval 同款 fail-closed 转移校验（pending→{resolved,expired,cancelled}，终态锁定）。
  - `get_escalation(request_id) -> EscalationEnvelope`（KeyError if 缺）。
  - `list_escalations(*, status="pending", run_id=None, session_id=None, company_profile_id=None, workspace_id=None)`。
  - `consume_escalation_ticket(request_id, nonce, ticket_sha256) -> EscalationEnvelope`：**单事务** `SELECT ... WHERE ticket_consumed=0`，比对 nonce+sha256，`UPDATE ... SET ticket_consumed=1`，受影响 0 行 → raise（单次消费原子保证）。
- **复用事件总线**：escalation 的 SSE 通知走 `add_event(run_id, "escalation.requested", ...)`（`state.py:515`）；对**无 run_id**（纯 chat / 治理）的 escalation，新增 `add_session_event` 或复用全局 `__escalations__` 频道（见 §4、§10）。

### 2.4 `backends.py` — P0 把静默执行改为 fail-closed 升迁
- **`_exec_tool` `:2805-2808`**：在现有 `posture_denies_tool` 之后插入升迁分支：
  ```python
  mode = limits.permission_policy.mode if limits.permission_policy else None
  posture = posture_for_mode(mode)
  if posture_denies_tool(posture, name):
      return f"error: permission denied: read-only mode ({mode}) forbids '{name}'; do not retry"
  if action_requires_human(mode, name):       # NEW: fail-closed 升迁，而非静默跑
      decision = self._escalate_and_wait(kind=EscalationKind.PERMISSION,
                                         tool_name=name, mode=mode, limits=limits)
      if not decision.granted:
          return f"error: permission denied by human gate for '{name}'; do not retry"
  ```
- **新增 `_AgentCliBackend._escalate_and_wait(...)`**（B 类基类，~2778 附近）：物化 `EscalationEnvelope`(kind=PERMISSION) + 加密票据 → 写 store → 发 `escalation.requested` → **阻塞轮询** `get_escalation` 直至 RESOLVED/EXPIRED 或本地超时；超时 → fail-closed denied。CLI 用户用 `superclaw escalation respond` 应答（§10 open question 1 讨论是否改异常+resume）。
- **`_approval_decision_for_policy` `:1156-1164`**：D1 **保持现行为**；D5 才把 Codex 原生回调改成"物化 RuntimeToolApproval + 挂起"（控制 PR 面积）。

### 2.5 `apps/api/main.py` — D2 新增 REST + SSE（包装同一 core）
- **`:4569` run events SSE**：在 `watched`/emit 加 `escalation.requested`/`escalation.resolved` 透传（已由 `add_event` 落进 events 表，天然随 run 流出）。
- 新增端点（§5）：`GET /api/escalations`、`GET /api/escalations/{id}`、`POST /api/escalations/{id}/respond`、`GET /api/escalations/stream`。**全部包装 `escalation.py` core**，零并行实现。

### 2.6 `cli.py` — D1 新增 `escalation` typer 子命令
- **`:205` 后**注册 `escalation_app`；`app.add_typer(escalation_app, name="escalation")`；复用 `_team_store()`（`cli.py:4034`）。

### 2.7 `ui_contracts.py` — 共享契约（§6）
- 新增 `build_escalation_contract()`（`:311` 旁）、`build_escalation_queue_payload(store, ...)`（`:1072` 旁），并入 `build_runtime_status_payload`（`:986`）。

### 2.8 Web（D3，纯表现层）
- `App.tsx:6234-6257` `watched` 加 `escalation.requested`/`escalation.resolved`；新增全局 escalation EventSource（订阅 `/api/escalations/stream`）。
- 新增 `apps/web/src/EscalationPopup.tsx`（通用弹窗：`prompt_text` + N 个 `options` 按钮 + 可选 free-text）+ pending 徽章。`TeamWorkbench.tsx:813-848` 审批卡迁移为渲染同一 envelope（D4）。

---

## 3. 数据结构 / Schema（field-level）

### 3.1 `EscalationEnvelope`（见 §1.1）— 不变量
- `kind ∈ EscalationKind`；`status` 转移 fail-closed（pending → resolved/expired/cancelled；终态锁定，复用 `Approval` 风格 `state.py:1155`）。
- `decided_option_id` 非空 ⇒ `status=resolved` 且 `∈ options[].id`。
- `ticket_consumed=True` ⇒ 不可再 respond。
- **detail 永远只是展示快照**，授权事实从不从 detail 推导（§0 护栏 2 镜像）。

### 3.2 六类决策记录（见 §1.1）— 不变量
- `GovernanceGate.requires_approved_entitlement` 对 pay/scan **恒 True**；handler 忽略用户"允许"若无 entitlement。
- `PermissionEscalation.requested_mode/current_mode` 仅展示；放行由 resume 二次 `posture_for_mode` 决定。

### 3.3 `TicketClaims`（见 §1.2）— 不变量
- `expiry > created`；`nonce` 唯一；`allowed_option_ids` ⊆ envelope.options ids；`run_state_fingerprint = sha256(json(sorted(关键状态)))`。

### 3.4 TS 类型（`apps/web/src/escalation.ts`，新）
```ts
export type EscalationKind = 'permission_escalation' | 'governance_gate'
  | 'runtime_tool_approval' | 'plan_approval' | 'clarifying_question' | 'issue_completion_review';
export interface EscalationOption { id: string; label: string; style: 'primary'|'default'|'danger'; free_text?: boolean; }
export interface EscalationEnvelope {
  request_id: string; kind: EscalationKind; prompt_text: string;
  run_id?: string; session_id?: string; options: EscalationOption[];
  default_option_id?: string; timeout_seconds?: number; status: string; created_at: number;
}
```
**TS 仅承载展示字段，不含 detail/ticket** —— 防前端硬编码授权语义（§0 护栏 3）。

---

## 4. CLI 命令（CLI = 唯一事实源）

```
superclaw escalation list   [--status pending|resolved|all] [--run RUN] [--session SID] [--company CID] [--json]
superclaw escalation show    <request_id> [--json]
superclaw escalation respond <request_id> --option <option_id> [--free-text TEXT] [--by local_user] [--ticket TOKEN] [--json]
```
- `list`：`store.list_escalations(...)` → `_emit_json` 数组（不含 ticket 明文）。
- `show`：`store.get_escalation(id).to_dict()`（含 detail 展示快照，不含票据明文）。
- `respond`：(1) 有 `--ticket` 则 `verify_ticket`，否则 CLI 本机操作者从 store 取指纹做单次消费；(2) `consume_escalation_ticket`；(3) `handler_for(env.kind)(...)` 强类型路由；(4) envelope→RESOLVED + 发 `escalation.resolved`；(5) `_emit_json`。

**JSON 输出（respond）**：
```json
{"escalation":{"request_id":"esc_ab12","kind":"permission_escalation","status":"resolved",
  "decided_option_id":"allow","decided_by":"local_user","resolved_at":1234.5},
 "applied":{"tool":"run_shell","granted":true},"grant":true}
```

---

## 5. API 端点（包装同一 core，无并行实现）

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/escalations` | `?status=pending&run=&session=&company=&workspace=` | `build_escalation_queue_payload(...)` → `{status_filter,count,escalations:[envelope...]}` |
| GET | `/api/escalations/{id}` | — | `store.get_escalation(id).to_dict()`（404 KeyError） |
| POST | `/api/escalations/{id}/respond` | `{option_id, free_text?, by, ticket?}` | 调 `escalation.respond_escalation(store, id, ...)`（**与 CLI 同一 core**）→ `{escalation, applied, grant}`；422 非法 option / 已消费 / 票据失效 |
| GET | `/api/escalations/stream` | SSE | `escalation.requested` / `escalation.resolved`（订阅全局 `__escalations__` + 可选 run/session 过滤） |

- 全部 `Depends(require_control_token)`（同 `apps/api/main.py:5085`）。
- `respond` **不内联授权**：解析参数→调 core，授权完全在 `escalation.py` handler（§0 护栏 3）。
- **SSE = 通知**：前端收 `escalation.requested` 后**必须**回 `GET /api/escalations/{id}` 拉权威再渲染。

---

## 6. `ui_contracts.py` 新增

```python
def build_escalation_contract() -> dict:
    return {
        "kinds": [k.value for k in EscalationKind],
        "statuses": [s.value for s in EscalationStatus],
        "option_styles": ["primary", "default", "danger"],
        "events": {"requested": "escalation.requested", "resolved": "escalation.resolved"},
        "kernel_may_override": ["governance_gate"],   # UI 须标注"点允许仍可能被内核拒"
    }

def build_escalation_queue_payload(store, *, status="pending", run_id=None, session_id=None,
                                   company_profile_id=None, workspace_id=None) -> dict:
    envs = store.list_escalations(status=status, run_id=run_id, session_id=session_id,
                                  company_profile_id=company_profile_id, workspace_id=workspace_id)
    return {"status_filter": status, "count": len(envs), "escalations": [e.to_dict() for e in envs]}
```
- 并入 `build_runtime_status_payload`（`:986` 已挂 `permission_modes`）：加 `"escalation": build_escalation_contract()`。

---

## 7. fail-closed / 治理红线核对

1. **默认即 fail-closed**：`_exec_tool` 的 ask 模式从"静默跑 shell"改为"物化 escalation + 阻塞 + 无应答超时拒"（`backends.py:2810`→§2.4）。无人 / 超时 / 票据失效 / 过期 / 状态漂移 —— 一律拒（§0 护栏 4）。
2. **授权硬隔离**：6 类各自 handler，`respond` 查 `_HANDLERS` 注册表而非 if/elif；缺 handler = fail-closed。kind 绑进加密票据 + GCM AAD，治理票据无法被当问询票据消费（堵路线图点名漏洞）。
3. **治理永不被 UI 降级**：`GovernanceGate` handler 无视用户"允许"，仍调 entitlement 校验；无已批准权限 → grant=False 保持阻断。`kernel_may_override` 让前端如实标注。
4. **SSE 非权威**：所有 surface 收事件后回 store 拉权威；单次消费事务是双花/重放最终防线。
5. **CLI 唯一事实源**：REST `respond` 与 CLI `escalation respond` 调同一 core，零并行实现。

---

## 8. back-compat / 迁移

- `allow`（bypass）行为**零变化**：`action_requires_human` 对 bypass 恒 False。
- `Approval` 表/`ApprovalType`/状态机/`decide_approval`/`approve grant|reject` CLI **全保留**；`issue_completion` 走 envelope 是投影，权威仍是 approvals 表。
- `governance-approvals.json`（`apps/api/main.py:2073`）保留权威落库；envelope 是只读投影（D4）。
- `human-gate`（`:4462`）保留；额外物化 envelope，不改 run 状态语义。
- 新 `escalations` 表纯增量，`CREATE TABLE IF NOT EXISTS` 自动建（`state.py:68` 风格），老数据无需迁移。
- 加密票据复用 `secrets.key`（`secrets_store.py:104`），无 key 时自动生成 0600。
- **取舍记录**：D1 只把 `run_shell` 标"需人审"，`write_file` 在 ask 仍自动 —— conservative 最小 fail-closed 增量（§10 让顾问压测）。


### 原子 PR 拆分（汇总表）

| PR | 范围 | 验收标准 | 依赖 |
|---|---|---|---|
| feat(escalation): fail-closed human gate + durable store + encrypted single-use ticket + CLI | permissions.py (action_requires_human, escalation_mode_contract); escalation.py NEW (EscalationEnvelope + 6 typed decision records + kind->handler registry + PERMISSION/CLARIFY/ISSUE_COMPLETION handlers + respond_escalation core); escalation_ticket.py NEW (issue/verify_ticket via secrets_store AES-GCM, single-use + 7-element binding + AAD); state.py (escalations table after :122 + save/get/list_escalations + consume_escalation_ticket atomic single-use tx); backends.py (_exec_tool :2805-2808 add action_requires_human escalation branch + _escalate_and_wait); cli.py (:205 register escalation_app + list/show/respond). Tests: tests/test_escalation_kernel.py, tests/test_escalation_ticket.py, tests/test_escalation_failclosed.py, tests/test_escalation_store.py | ask-mode B-class run_shell no longer silently executes — materializes PENDING escalation and blocks; no response times out -> denied (no silent allow). escalation respond with valid ticket runs handler -> RESOLVED; repeat respond rejected by single-use consume. Tampered ticket (1 byte) -> TicketError rejected. allow-mode behavior unchanged (zero regression). issue_completion handler delegates to team_kernel.decide_approval, result identical to existing approve grant. handler_for missing kind raises EscalationDenied (fail-closed). ruff clean, pytest green. | none (first PR, the P0 foundation before any UI) |
| feat(api): escalation REST inbox + SSE requested/resolved events | apps/api/main.py (GET /api/escalations, GET /api/escalations/{id}, POST /api/escalations/{id}/respond, GET /api/escalations/stream; SSE escalation.requested/resolved passthrough in run events :4569 + __escalations__ channel); ui_contracts.py (build_escalation_contract near :311, build_escalation_queue_payload near :1072, attach to build_runtime_status_payload :986). Tests: tests/test_api_escalations.py | REST list/show/respond byte-identical to CLI (same core respond_escalation function); respond invalid option / already-consumed / bad ticket -> 422; control-token enforced; SSE emits escalation.requested while store remains authority (envelope still GET-able after SSE drop). | D1 |
| feat(web): generic escalation popup (text + N buttons) + pending badge | apps/web/src/EscalationPopup.tsx NEW; apps/web/src/escalation.ts NEW (TS types, display fields only); App.tsx (global escalation EventSource subscribing /api/escalations/stream + watched list :6234-6257 add events + popup mount + pending badge). Tests: apps/web/tests/escalation-popup.test.tsx | On escalation.requested -> GET authoritative envelope -> popup renders prompt_text + N buttons; click -> POST respond -> popup closes + escalation.resolved updates badge; free_text only enabled when option.free_text; governance-kind buttons show kernel_may_override hint (allow may still be blocked by kernel). No front-end authorization decision anywhere (pure presentation). | D2 |
| refactor(escalation): route governance-approvals / team Approval / human-gate through the envelope transport | apps/api/main.py (/api/governance/approvals :2085 materialize GOVERNANCE envelope; team approvals :5085/:5455 <-> issue_completion envelope projection; /api/runs/{id}/human-gate :4462 materialize envelope); team_kernel.py (submit_for_review :694 emit envelope projection); apps/web/src/TeamWorkbench.tsx :813-848 render envelope. Tests: tests/test_escalation_migration.py, apps/web/tests/team-approval-envelope.test.tsx | All 3 systems' pending items appear in /api/escalations and the unified popup; each decision path byte-identical to pre-migration (governance still fail-closed, team still flips issue/lock, human-gate still pauses run). Authorization logic zero-merged — respond routes strictly by stored kind, governance never shares the issue-completion code path. governance-approvals.json and approvals table remain authoritative (envelope is projection). | D3 |
| feat(escalation): normalize Codex/Claude native approval callbacks into RuntimeToolApproval | codex_app_server.py :616-649 (_handle_server_request materialize RUNTIME_TOOL envelope + suspend runtime until valid ticket); backends.py :1156-1164 (_approval_decision_for_policy route through escalation); claude adapter native approvals if any. Tests: tests/test_escalation_runtime_normalize.py | Codex native commandExecution/fileChange approval no longer auto-answered by policy; materializes escalation + suspends; front-end ticket resume restores runtime without breaking sandbox/should_retire_session; timeout -> decline (fail-closed). | D4 |



### 待评审的开放问题

- B-class blocking model: does _escalate_and_wait synchronously polling the store inside _exec_tool starve the orchestrator thread / blow the run budget? Should it instead raise EscalationPending + move run to WAITING_FOR_HUMAN_GATE + resume-reenter rather than block inline? This couples fail-closed with run lifecycle.
- No-run_id escalation channel: pure-chat / governance escalations have no run_id; routing SSE through a global __escalations__ channel — does it leak cross-session escalations to other control-token holders? Is session/company-scoped subscription auth needed?
- CLI respond ticket trust boundary: without --ticket, a same-machine CLI operator consumes the store fingerprint directly — treating 'same machine = authorized'. Is this a privilege escalation on multi-user machines? Should CLI be forced to carry a ticket too?
- ask-mode minimal fail-closed increment (section 8 tradeoff): gating only run_shell and not write_file — does this leave a bypass where an ask-mode agent uses write_file to modify .git/hooks then triggers it? Where should the fail-closed boundary be drawn?
- run_state_fingerprint selection: which state fields go into the fingerprint to detect 'state tampered after materialization' WITHOUT falsely rejecting legitimate responses due to normal concurrent run progress (over-tight = availability fail-closed)?
- D5 Codex runtime suspension timeout & sandbox: while the app-server is suspended waiting for a ticket, how are Codex turn timeout / heartbeat / session keepalive handled? Does suspend-then-resume break should_retire_session semantics (codex_app_server.py:606)?
- Governance entitlement re-check wiring: which existing module does handle_governance call to verify 'approved entitlement' (fusion vs plugin entitlement vs company high_risk_policies)? Is there already a callable 'is this pay/scan intent approved' predicate, or must it be built? This determines whether the GOVERNANCE handler is truly fail-closed or an empty shell.

### 已识别风险

- P0 fail-closed tightening (D1) changes ask-mode B-class run_shell from silent-execute to human-gated — a behavior change for any existing ask-mode workflow that relied on shell auto-running. Mitigation: scoped to run_shell only, allow-mode untouched, documented as the explicit goal; but real workflows may break and need a migration notice.
- Inline blocking in _exec_tool (_escalate_and_wait) risks deadlocking the worker thread / exhausting budget if no human responds and the local timeout is long; open question #1 may force a redesign to exception+resume before D1 lands.
- Encrypted ticket reuses secrets.key (secrets_store.py:104). If that key file is absent in some deploy paths or the AES-GCM dependency is unavailable in a frozen/installed-app backend, ticket issue/verify fails closed and ALL escalations become unanswerable — must verify the key path works in the installed Tauri-bundled backend, not just dev.
- D4 migration must keep three authorization paths physically separate; the strongest risk is accidental handler merging (the exact failure the roadmap forbids) — a reviewer must confirm respond routes strictly by stored kind and governance never shares the issue-completion code path.
- D5 suspending native Codex app-server approval callbacks (codex_app_server.py:616-649) could break sandbox semantics, session retirement, or turn-interrupt timing; highest-blast-radius change, correctly sequenced last but still risky.
- SSE-as-notification discipline depends on every surface re-fetching the authoritative envelope; if any surface trusts the SSE payload as authority for a governance decision, the fail-closed guarantee is silently undermined — needs an enforced contract test that the popup only renders after GET.


---


## 5. 方向五　右侧 to-do（内核 ExecutionGraph + 顺序化事件）

**落地概述**：方向五 — kernel-owned ExecutionGraph + sequenced TaskEvents (no frontend-invented plan). MVP = real-time execution trace owned by the Python core; Web only renders snapshot + applies incremental row updates from sequenced events; runtime-native todo (Claude TodoWrite / Codex plan) is normalized in the CORE adapter, never the frontend. plan-only outline is a kernel-owned non-binding phase deferred to a later PR. No user edit/skip in MVP.


## 方向五实现规格：kernel-owned ExecutionGraph + sequenced TaskEvents

### 0. 现状核实（每条 file:line 已读源码）

**地基比预期更好——90% 已具备，本方向是"补 seq + 补 task.updated + 接 Web 监听 + 接 adapter 归一化"，而非造模型。**

- **单调 seq 已天然存在**：`state.py:86-91` 的 `events` 表已是 `id INTEGER PRIMARY KEY AUTOINCREMENT`；`state.py:536-555 list_events_after(run_id, after_id)` 已返回 `id`；SSE 流 `apps/api/main.py:4587-4592` 已经把 **所有事件类型**（无类型过滤）逐条 yield，并以 `event["id"]` 作游标。**结论：DB 层与传输层的"单调序列"已经存在，无需新表。** 但 `id` 是 **全 DB 全局自增**（跨 run 单调，非 per-run 连续），消费端只能用作"严格递增游标"而非"连续计数"。
- **task.* 事件已部分 emit，但不全、无 seq、Web 不听**：
  - `orchestrator.py:1778 _emit_task_start` emit `task.started`（含 task_id/role/backend/depends_on/attempt_index）。
  - `orchestrator.py:1898`（cancelled）/`1907`（exit!=0）/`1910`（exit==0）emit `task.failed`/`task.completed`。
  - **缺**：`task.updated`（运行中进度/原生 todo 推进）；所有 task.* payload **缺 `seq` 字段**；Web `watched` 列表（`App.tsx:6234-6257`）**不含任何 `task.*`**，目前靠 `worker.*`/`child_*` 触发 `scheduleDetailRefresh()`（250ms 防抖全快照重拉，`App.tsx:6226-6232,6268-6271`）。
  - **双路径重复**：顺序路径在 `orchestrator.py:2185-2264` 内联 emit，并行路径走 `_emit_task_start`(1762)/`_record_task_result`(1835)。新事件必须两路都补，否则 concurrency>1 时漂移。
- **渲染已存在且 snapshot-driven**：`App.tsx:3416 selectedRun?.task_graph?.tasks`；Plan 面板 `App.tsx:8018-8027` 已渲染 `selectedTasks`（dot/title/status pill），`planTotalCount/planDoneCount/planPercent`（7925-7931）已算好；`taskStatusTone()`（2855）已映射 status→tone。**Web 改动极小。**
- **快照已带 task_graph**：`apps/api/main.py:4487-4502 GET /api/runs/{run_id}` → `run_read_payload`（3215-3224）→ `run.to_dict()`，而 `RunSession.to_dict`（`models.py:462-467`）已序列化 `task_graph`。
- **原生 todo 归一化点（核心）**：
  - Claude：`claude_stream.py:210-216`，`etype=="assistant"` 时遍历 `tool_use` block，**当前只 `_emit("tool.started", {"tool": block.get("name"), ...})`，丢弃了 `block.get("input")`**——TodoWrite 的 todos 数组就在 `input` 里，未被读取。
  - Codex：`codex_app_server.py:456-472`，`method=="item/started"` 按 `item.type` 分流（commandExecution/fileChange/reasoning/mcpToolCall），**没有 `plan`/`todoList`/`taskList` 分支**——Codex app-server 的 plan 项被丢弃。
  - 两个 adapter 的 `on_event` 都是同一个 `limits.event_sink`（`backends.py:1275`/`1024`），它来自 `_make_worker_event_sink(run_id)`（`orchestrator.py:264-279`），**只绑 run_id、不带 task_id**。这是归一化的关键约束。

**铁律核对**：CLI 唯一事实源 → 新 CLI 命令与新事件先落内核；fail-closed → seq 断裂/未知字段降级为全快照重载（不静默渲染半状态）；表层零新增语义 → Web 只渲染内核吐出的 task.* + 快照，绝不在前端造 plan；身份 → task_id 是稳定标识。

---

### 1. 核心数据结构（extend，不另起平行模型）

**裁决：不新增 `ExecutionGraph`/`PlanGraph` 独立持久化表。** 现有 `TaskGraph`/`TaskNode`（`models.py:282-443`）**就是** ExecutionGraph（真实执行轨迹）：节点 status 随 orchestrator 推进，`_apply_discovered_tasks`（`orchestrator.py:839-876`）已支持运行中扩图。路线图所说的 PlanGraph/ExecutionGraph/TaskEvent/TaskSnapshot 是**展示契约 + 事件契约**，不是四张新表。落地为：

#### 1a. `TaskNode` 扩字段（`models.py:282-300`，全部带默认值，向后兼容）

```python
@dataclass
class TaskNode:
    task_id: str
    role: WorkerRole
    title: str
    depends_on: list[str] = field(default_factory=list)
    status: str = "pending"
    fanout: dict[str, Any] | None = None
    # --- 方向五新增（执行轨迹元数据，全可选，from_dict 容旧行）---
    node_kind: str = "stage"          # "stage"(EXPLORE/PLAN/... 蓝图节点) | "todo"(原生 todo 归一化出的子项)
    origin: str = "graph"             # "graph" | "discovered" | "runtime_todo"
    source_runtime: str | None = None # 归一化来源（"claude"/"codex"），仅 node_kind=="todo"
    progress_note: str = ""           # 运行中人类可读进度（task.updated 写入，展示用）
    started_at: float | None = None   # 首次进入 running
    updated_at: float | None = None   # 最后一次状态/进度变化
```
- `TaskNode.from_dict`（`models.py:297-299`）当前是直接 `**{k:v for k in data if k!="role"}` splat，**含未知键的旧行会 TypeError**。**必须**改为按 `cls.__dataclass_fields__` 过滤（与 `AgentProfile.from_dict`/`Issue.from_dict` 同款 `models.py:1109-1112`），保证前向兼容。
- `to_dict`（`models.py:292-295`）`asdict` 自动带上新字段，无需改。

#### 1b. `TaskEventEnvelope`（新 dataclass，`models.py`，task.* 事件的展示契约）

不持久化为独立行（事件本体已存 `events` 表），仅作为 **payload 构造器 + 契约文档**，统一所有 task.* 事件的 payload 形状：

```python
@dataclass
class TaskEventEnvelope:
    """统一 task.* 事件 payload 形状。seq 由 DB 事件 id 充当（全局单调游标）。
    surfaces 只读不写：所有 task.* 都经 _emit_task_event() 产出。"""
    task_id: str
    role: str
    phase: Literal["started", "updated", "completed", "failed"]
    status: str                       # pending|running|completed|failed|cancelled
    node_kind: str = "stage"
    backend: str | None = None
    attempt_index: int | None = None
    depends_on: list[str] = field(default_factory=list)
    title: str | None = None
    progress_note: str = ""
    source_runtime: str | None = None
    emitted_at: float = field(default_factory=time)

    def payload(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}
```
- **seq 不进 payload，由 SSE 的 `event["id"]` 承载**（已存在，见 §3）。这避免在 payload 里再造一个会与 DB id 漂移的计数器（单一序列源）。

#### 1c. `TaskSnapshot`（已存在，无需新建）

权威快照 = `GET /api/runs/{run_id}` 的 `task_graph`（`apps/api/main.py:4487-4502`）+ CLI `superclaw run-inspect tasks <id> --json`（§7）。**SSE 只做增量，权威永远是 durable store 的快照**（北极星护栏 3）。

---

### 2. 事件发射：补 `task.updated` + 统一经一个 helper（`orchestrator.py`）

#### 2a. 新增统一发射器，消灭双路径重复
新增 `orchestrator.py`：
```python
def _emit_task_event(self, session, task, phase, *, backend=None, attempt_index=None, progress_note="", source_runtime=None):
    env = TaskEventEnvelope(
        task_id=task.task_id, role=task.role.value, phase=phase, status=task.status,
        node_kind=getattr(task, "node_kind", "stage"),
        backend=getattr(backend, "name", None) if backend else None,
        attempt_index=attempt_index, depends_on=list(task.depends_on),
        title=task.title, progress_note=progress_note, source_runtime=source_runtime,
    )
    self.store.add_event(session.run_id, f"task.{phase}", env.payload())
```
- **改 `_emit_task_start`（1776-1780）**：内联 `add_event("task.started", ...)` 换成 `self._emit_task_event(..., "started", backend=backend, attempt_index=attempt_index)`；同步替换顺序路径 `2185-2195` 的内联 `task.started`。
- **改 `_record_task_result`（1907/1910）与顺序路径**：`task.completed`/`task.failed` 改走 `_emit_task_event(..., "completed"/"failed", ...)`；cancelled 分支（1898）→ phase="failed"（status 仍是 "cancelled"，phase 表终止失败，status 区分原因）。
- **行为保持**：事件类型字符串、既有字段（task_id/role/backend/status/attempt_index）一字不变，仅**增加** title/node_kind/depends_on/progress_note。

#### 2b. 新增 `task.updated`（运行中进度，原生 todo 推进的载体）
`task.updated` 在两处产生：(1) 归一化层（§4）adapter 把 Claude TodoWrite/Codex plan 子项标 in_progress/completed 时经 task-scoped sink emit；(2) 保留 `_apply_discovered_tasks` 876 的 `task.added`（新增节点，是 task.started 前导）。`task.updated` 不改 status 三态机（仍由 orchestrator 在 started/completed/failed 推进），只更新 progress_note/updated_at。**fail-closed**：引用的 task_id 不在当前 graph → 丢弃 + emit `task.warning`，不创建幽灵节点。

#### 2c. seq 单调保证
DB `events.id` 是 SQLite autoincrement，单写者（orchestrator 串行 add_event；并行 frontier 的 `_record_task_result` 仍主线程串行调用 1943-1944）→ 严格单调。adapter task-scoped sink 走同一 `store.add_event` 同表，共享同一序列。

---

### 3. Web：把 task.* 加入监听 + 增量单行更新（小改动）

#### 3a. `App.tsx:6234-6257` watched 列表追加
```diff
       'worker.planned',
       'worker.leased',
       'worker.cancelled',
+      'task.started',
+      'task.updated',
+      'task.completed',
+      'task.failed',
+      'task.added',
       'command.started',
```

#### 3b. 增量 reducer + 兜底（`App.tsx:6259-6276` handler）
新增 `const [lastTaskSeq, setLastTaskSeq] = useState(0)`，用 SSE `event.lastEventId`（前提：API 在 4591-4592 补 `yield f"id: {event['id']}\n"`，§8）：
```ts
} else if (type.startsWith('task.')) {
  const seq = Number((event as MessageEvent).lastEventId || 0);
  if (seq && seq <= lastTaskSeq) return;             // 旧/重放忽略
  setLastTaskSeq(seq || lastTaskSeq);
  if (type === 'task.added') {                        // 结构变化 → 全快照（fail-closed）
    scheduleDetailRefresh();
  } else {
    setSelectedRun((cur) => applyTaskEvent(cur, type, payload));  // 命中不到则回退快照
  }
}
```
`applyTaskEvent` 是纯函数，按 `payload.task_id` 在 `run.task_graph.tasks` 找节点更新 status/progress_note/title；**未命中不创建节点**、返回原 run 并触发 `scheduleDetailRefresh()`（fail-closed）。因 `events.id` 全局自增，task.* 之间夹其它事件、id 非连续，故**不做"连续性"判定**；真正兜底是 `onerror`→`scheduleDetailRefresh`+ 重连首次 `loadRunDetail`。保留 worker.* 的 250ms 防抖全快照路径不变（向后兼容）。

#### 3c. TS 类型扩展（`App.tsx:184-190 RunTask`）
```diff
   status?: string;
+  node_kind?: string;
+  progress_note?: string;
+  source_runtime?: string | null;
```
渲染 `App.tsx:8020-8026` 追加 `progress_note`（running 时 title 下小字）+ `node_kind==="todo"` 缩进样式。纯表现层。

---

### 4. 原生 todo 归一化（CORE adapter，禁前端映射）

`event_sink` 只绑 run_id，adapter emit 时不知 task_id。**推荐方案**：adapter 识别 todo 后 emit 中性事件 `runtime.todo`（带 items+parent 上下文），由 core normalizer 转 task.*——避免归一化逻辑散落 backend：
- `claude_stream.py:210-216`：tool_use 且 `name=="TodoWrite"` → 额外 `_emit("runtime.todo", {"runtime":"claude","items": block.get("input",{}).get("todos",[])})`（读出此前丢弃的 input）。
- `codex_app_server.py:456-472` 与 508+：`item.type in {"plan","todoList","taskList"}` → `_emit("runtime.todo", {"runtime":"codex","items": item.get("items") or item.get("plan") or []})`，并在 item/updated/completed 对应分支 emit 增量。
- **新文件 `task_normalizer.py`（core）**：`normalize_runtime_todo(run_id, parent_task_id, runtime, items, store, graph)`。把 items 映射成 `node_kind="todo"` TaskNode（task_id = `f"{parent_task_id}::todo::{idx}"`，命名空间与蓝图 `task_*` 隔离），首见 emit `task.added`+`task.started`，变化 emit `task.updated`/`task.completed`，全部经 store/graph（CLI/Web 同源）。Claude 与 Codex 共用此 normalizer，零第二套语义。

**fail-closed**：items 形状异常 → 记 `task.warning`，不建半截节点。todo 节点 `depends_on` 为空或仅指向 parent，且**不得**进入 `_pending_frontier` 的执行调度（仅展示）。

---

### 5. plan-only 阶段（kernel-owned，非约束性 milestone 大纲，延后到 E7）

**不**做 Web/API 便利端点（顾问阻断点）。plan-only 是内核拥有的**非绑定大纲**：`superclaw run-inspect plan <run_id> --json` 输出 `{milestones:[...], non_binding:true}`，由内核从蓝图 topology 角色派生（MVP 不解析 worker 自由文本，避免第二套规划语义），呈现为意图大纲而非确定 checklist。**MVP 不含** edit/skip/reorder（留 P2，依赖 scheduler contract）。本规格里排最后（E7），只做 CLI+契约，不接 Web 编辑。

---

### 6. ui_contracts.py 新增
新增 `build_task_event_contract()`（与 `build_permission_mode_contract` 311 同款内核单一定义点）：
```python
def build_task_event_contract() -> dict[str, Any]:
    return {
        "event_types": ["task.added","task.started","task.updated","task.completed","task.failed","task.warning"],
        "node_kinds": ["stage","todo"],
        "task_statuses": ["pending","running","completed","failed","cancelled"],
        "status_tone": {"completed":"good","done":"good","failed":"bad","cancelled":"bad",
                        "running":"live","in_progress":"live","pending":"neutral"},
        "seq_source": "sse_event_id",
        "incremental_then_snapshot": True,
        "plan_only": {"binding": False, "user_editable": False},
    }
```
经 `GET /api/contracts/tasks` 暴露；Web 用其 `status_tone` 替换 `App.tsx:2855 taskStatusTone` 硬编码，消除前端与 CLI 漂移。

---

### 7. CLI 命令（Typer 风格，CLI 唯一事实源）
CLI 用 Typer（命令是顶层函数，如 `events()` 3960、`watch()` 4004）。新增 sub-app `run-inspect`（命名避开既有顶层命令）：
- `superclaw run-inspect tasks <run_id> [--json]`：快照，输出 `{run_id, tasks:[TaskNode.to_dict...], counts:_task_status_counts(session)}`（复用 cli.py:1173）。未知 run_id → exit 1。
- `superclaw run-inspect plan <run_id> [--json]`（E7）：`{run_id, milestones:[...], non_binding:true}`。
- `watch`（4004-4024）：从 `list_events` 切到 `list_events_after` 以给每行带 `seq=id`。

JSON 形状（tasks --json）与 API 快照逐字段一致：
```json
{"run_id":"run_xxx","tasks":[{"task_id":"task_a","role":"implement","title":"...","status":"running","depends_on":["task_b"],"node_kind":"stage","progress_note":"editing models.py","source_runtime":null}],"counts":{"running":1,"completed":2,"pending":1}}
```

---

### 8. API 端点（薄包装 core，无平行实现）
- 快照复用 `GET /api/runs/{run_id}`（4487，已含 task_graph）；**新增** `GET /api/runs/{run_id}/tasks` 返回与 CLI `run-inspect tasks --json` **逐字段一致**的轻量 JSON。
- **事件流**复用 `GET /api/runs/{run_id}/events`（4569），在 4591-4592 **补 `id:` SSE 行**——Web 拿 lastEventId 当 seq、断线重连自动带 Last-Event-ID 的关键接线。
- `GET /api/contracts/tasks` → `build_task_event_contract()`。
- plan-only `GET /api/runs/{id}/plan`（E7）。

---

### 9. fail-closed / 治理红线核对
1. 权威 = durable store+snapshot，SSE 只通知：seq 异常/断线/task.added → 全快照重载，快照永远赢（护栏 3/4）。
2. 未知 task_id fail-closed：task.updated/归一化引用不存在节点 → 丢事件+task.warning，前端 applyTaskEvent 未命中即回退快照，绝不渲染幽灵行。
3. CLI 唯一事实源：归一化在 task_normalizer.py 一处；CLI/API/Web 读同一 store；前端零 plan 生成、事件名/tone 全经 ui_contracts。
4. 同 id 隔离：todo 节点用 `{parent}::todo::*` 命名空间与蓝图隔离；_apply_discovered_tasks(839) 既有 duplicate-id 校验复用。
5. plan-only 非绑定、不可编辑，杜绝表层绕过 orchestrator 的 status 机。
6. 纯执行轨迹可观测性，不新增业务能力/权限路径。

---

### 10. back-compat / 迁移
- TaskNode 新字段全有默认值；from_dict 改按 __dataclass_fields__ 过滤（对齐 RunSession.from_dict 481-482 既有防御），旧行/脏键容错。
- 事件类型/字段只增不改，旧 Web/CLI 消费者无感。
- Web watched 纯追加；worker.* 防抖路径保留并存。
- SSE id: 行新增，旧客户端忽略未知字段。
- 旧 run 无 task.* 历史：首次 loadRunDetail 全快照渲染，不依赖事件回放。

---

### 11. 原子 PR 拆分（E1..E7）
E1 事件统一+seq+CLI、E2 Web live、E3 CLI、E4 API/contract、E5 Web contract、E6 归一化、E7 plan-only。详见 pr_breakdown（每项含 test 文件）。


### 原子 PR 拆分（汇总表）

| PR | 范围 | 验收标准 | 依赖 |
|---|---|---|---|
| feat(core): unify task.* emission through _emit_task_event and surface seq via SSE id | models.py (TaskNode 扩 node_kind/origin/source_runtime/progress_note/started_at/updated_at + from_dict 改按 __dataclass_fields__ 过滤; 新增 TaskEventEnvelope dataclass); orchestrator.py (新增 _emit_task_event; 替换 _emit_task_start 1776-1780 / _record_task_result 1898/1907/1910 / 顺序路径 2185-2195 的内联 add_event; 补 task.updated/task.warning helper); apps/api/main.py (GET /api/runs/{id}/events 4591-4592 补 'id:' SSE 行) | task.started/completed/failed 经单一 _emit_task_event 产出且并行/顺序两路径 payload 一致(含 task_id/role/backend/status/attempt_index/title/node_kind/depends_on);既有字段一字不变;SSE 每事件多一行 id:<events.id>;旧 run 反序列化不报错;ruff clean。测试: tests/test_orchestrator.py(task.* payload 含新字段且两路径一致; task.updated 未知 task_id 被拒产 task.warning); tests/test_models.py(TaskNode from_dict 容旧行+脏键; TaskEventEnvelope.payload 去 None); tests/test_api_events_sse.py(SSE 含 id: 行且与 list_events_after 的 id 一致) | (none) |
| feat(web): live single-row task updates from sequenced task.* events with snapshot fallback | apps/web/src/App.tsx (watched 6234-6257 追加 task.added/started/updated/completed/failed; SSE handler 6259-6276 新增 task.* 分支用 event.lastEventId 作 seq, 严格递增→applyTaskEvent 单行, task.added/断线→scheduleDetailRefresh; 新增 applyTaskEvent 纯函数+lastTaskSeq state; RunTask 类型 184-190 加 node_kind/progress_note/source_runtime; Plan 面板 8020-8026 渲染 progress_note + todo 缩进) | 运行中收到 task.* 对应行 status/progress_note 即时更新无需整快照重拉;未知 task_id 不创建幽灵行而回退快照;断线重连首次 loadRunDetail 全快照对齐;worker.* 防抖路径不回归;npm test 通过。测试: apps/web/tests/task-live-update.test.tsx(applyTaskEvent 命中更新单行/未命中回退/旧 seq 忽略; Plan 面板随 task.* 增量渲染 progress_note) | E1 |
| feat(cli): superclaw run-inspect tasks/plan --json as source-of-truth snapshot | packages/superclaw/src/superclaw/cli.py (新增 run_app Typer sub-app via add_typer name='run-inspect'; run_tasks 复用 _task_status_counts 1173 + task_graph 序列化; run_plan 骨架返 non_binding=true; watch 4004-4024 从 list_events 切到 list_events_after 输出 seq=id) | run-inspect tasks <id> --json 输出 {run_id,tasks[],counts} 与 API /api/runs/{id} 的 task_graph 同字段;watch --json 每行带 seq;未知 run_id exit 1;ruff clean。测试: tests/test_cli.py(run-inspect tasks --json 形状与字段; 未知 id exit 1; watch --json 带 seq) | E1 |
| feat(api): GET /api/runs/{id}/tasks and /api/contracts/tasks wrapping core | apps/api/main.py (新增 GET /api/runs/{id}/tasks 包装与 CLI run-inspect tasks 同款逻辑, 逐字段一致; 新增 GET /api/contracts/tasks → build_task_event_contract); ui_contracts.py (新增 build_task_event_contract) | /api/runs/{id}/tasks 与 CLI --json 字段逐一相同(同源);/api/contracts/tasks 返回事件名/状态枚举/status_tone 单一来源;端点为薄包装无业务逻辑下沉。测试: tests/test_api.py(/api/runs/{id}/tasks 字段=CLI run-inspect tasks; /api/contracts/tasks 含全部 event_types 且与 orchestrator 实际 emit 类型集一致) | E3 |
| feat(web): consume /api/contracts/tasks for status tone (kill hardcoded enum drift) | apps/web/src/App.tsx (启动拉 /api/contracts/tasks; taskStatusTone 2855 改为消费契约 status_tone, 缺失回退现有硬编码默认; watched 事件名以契约 event_types 为准) | 前端 task 状态 tone/事件名来自内核契约而非硬编码;契约不可达优雅回退默认;无功能回归;npm test 通过。测试: apps/web/tests/task-contract.test.tsx(status_tone 来自契约; 契约缺失回退默认) | E2, E4 |
| feat(core): normalize Claude TodoWrite / Codex plan into task.* via task_normalizer (no frontend mapping) | claude_stream.py(210-216: TodoWrite tool_use 读 block.input.todos 并 _emit 'runtime.todo'); codex_app_server.py(456-472 与 508+: item.type in {plan,todoList,taskList} → _emit 'runtime.todo'); 新文件 task_normalizer.py(normalize_runtime_todo: items→node_kind=todo 节点 task_id={parent}::todo::idx, emit task.added/started/updated/completed, fail-closed 形状校验); orchestrator.py(worker sink 接 runtime.todo→normalizer; backends.py claude~1200/codex~1020 传 parent task 上下文) | Claude TodoWrite 与 Codex plan 都归一化成相同 task.* 流且经 store(CLI/Web 同源);todo 节点命名空间不与蓝图 task_* 冲突;items 异常 fail-closed(task.warning 不建半截节点);todo 节点不进入 _pending_frontier 执行调度;现有 tool.* 不回归。测试: tests/test_task_normalizer.py(claude/codex items→统一 task.*; 异常 fail-closed; 幂等推进); tests/test_claude_stream.py(TodoWrite→runtime.todo 带 items); tests/test_codex_app_server_runtime.py(plan item→runtime.todo) | E1 |
| feat(core): kernel-owned plan-only milestone outline (non-binding, read-only) | orchestrator.py(从蓝图 topology 角色派生非绑定 milestones, 不解析 worker 自由文本); cli.py(run_plan 填真实 milestones); apps/api/main.py(GET /api/runs/{id}/plan 包装); ui_contracts.py(plan_only 契约已在 E4) | run-inspect plan --json 返 {milestones[],non_binding:true};呈现为意图大纲非确定 checklist;MVP 无 edit/skip/reorder;API 薄包装 CLI。测试: tests/test_cli.py(run-inspect plan --json 形状/non_binding); tests/test_api.py(/api/runs/{id}/plan 字段=CLI; 无写端点) | E4, E6 |



### 待评审的开放问题

- seq 语义脆弱：本规格把 SQLite events.id（全 DB 全局自增）当作 seq 游标，非 per-run 连续计数。相邻 task.* 事件的 id 必然非连续（中间夹 command.*/artifact.*），前端无法用 id===last+1 判是否丢事件，只能靠断线重连+task.added 触发全快照兜底。请压测：daemon 多进程并发写同一 SQLite 时，autoincrement 跨连接是否仍对单个 run 严格单调不回退？若某次 SSE 未触发 onerror 但丢了一条 task.completed，单行渲染会卡在 running 直到下一次 run.* 事件才自愈——这个'短暂卡 running'窗口可接受吗？
- task-scoped sink 的归一化注入：event_sink 只绑 run_id(_make_worker_event_sink orchestrator.py:264)。规格选 adapter emit 中性 runtime.todo + core normalizer 转 task.*。在并行 frontier(concurrency>1, 多 task 同时跑)下，runtime.todo 经全局 run sink 如何可靠携带 parent_task_id 而不串台？是否必须改成 task-scoped wrapper 才能正确归属？
- task.updated 与 orchestrator status 独占机：归一化出的 node_kind=todo 节点的 completed 由 normalizer 直接置(绕过 worker 执行)。这是否违反'orchestrator 独占 status 机'？todo 子节点与蓝图节点用不同推进路径，是否会让 _pending_frontier(依赖 status in {pending,completed} orchestrator.py:2135)误判 frontier 或让 todo 节点意外被拉进 backend.run？隔离是否足够？
- plan-only 非绑定大纲的真实来源：规格限定 MVP 只回放蓝图 topology 的角色名作 milestones、不解析 worker 文本，以避免第二套规划语义。这会不会让 plan 输出太空洞(仅 EXPLORE/PLAN/IMPLEMENT/VERIFY/REVIEW 五个固定词)而对用户无价值？还是该直接把 E7 从 MVP 剖出顺延到 P2？
- Web 单行增量 vs 250ms 防抖全快照并存：两条路径都改 selectedRun，是否存在竞态(单行更新被随后到达的防抖快照覆盖成旧值，或反之)？快照是权威最终会赢，但中间帧抖动是否可接受？是否该在 task.* 命中时取消 pending 的防抖 timer？
- from_dict 收紧的回归面：把 TaskNode.from_dict 从裸 splat 改按 __dataclass_fields__ 过滤(models.py:297-299)。是否存在依赖'未知键透传'的代码路径会被该过滤静默丢弃(如某处往 TaskNode dict 塞额外键再 from_dict 回来)？虽对齐 AgentProfile/Issue 同款写法，但需确认 TaskNode 无此依赖。

### 已识别风险

- seq 游标语义脆弱：用全局 events.id 当 per-run seq，相邻 task.* 不连续，无法精确检测丢事件；只能靠断线重连全重载兜底。若某次 SSE 未触发 onerror 但确实丢了一条 task.completed，单行渲染会停在 running，直到下一次任意 run.* 事件触发 loadRunDetail 才自愈——存在短暂卡 running 窗口。
- 双路径 emit 未彻底合并：orchestrator 顺序路径(2185-2264)与并行路径(_emit_task_start/_record_task_result)是两段几乎重复的代码。E1 只把 add_event 换成 _emit_task_event，其余(advance_attempt/sync_status/save_run)仍重复，未来只改一路会再次漂移。本规格未做大重构(避免 E1 过大)，留技术债。
- 原生 todo 归一化在并行 frontier 下可能归错 parent：concurrency>1 时多 task 的 worker 同时向同一 run-scoped sink 吐 runtime.todo，若 normalizer 无法可靠区分来源 task_id，todo 子项可能挂错 parent。需在 E6 显式随 runtime.todo 传 parent_task_id 并验证隔离。
- todo 子节点污染执行 frontier：归一化出的 node_kind=todo 节点若 status/depends_on 设置不当，可被 _pending_frontier(orchestrator.py:2135 依赖 status in pending/completed)当成可执行节点拉进 backend.run 造成幽灵执行。必须保证 todo 节点只展示不调度。
- Codex plan item 类型名是猜测：规格假设 item.type ∈ {plan,todoList,taskList}，未在真机 transcript 验证。E6 落地前需用真实 codex app-server 输出核对字段名，否则归一化静默不触发(无报错的功能缺失)。
- 前端 lastEventId 依赖 SSE id: 行：E2 的单行更新依赖 E1 给 SSE 补 id: 行。若 id: 行被某代理/缓冲层剥离，event.lastEventId 为空→seq 永远 0→task.* 被当非递增走快照或忽略，单行优化失效(降级到现状不致命)。
- 契约消费(E5)引入启动期网络依赖：taskStatusTone 改消费 /api/contracts/tasks，若该端点慢/失败首屏 task 着色回退默认。需保回退默认与契约值一致否则刷新前后 tone 跳变。


---


## 7. 评审裁决（Codex + Gemini 第二轮 + 主代理把关）

### 7.0 总判

- **两路第二轮独立验证、高度收敛**。Gemini 判定 方向1/3/5「通过（需修正）」、方向2/4「不通过」；Codex 判定五向均「不通过（修正后可实施）」。差异**仅在口径**（"需修正"是否计为不通过），**实质要修的点完全一致**。
- **主代理把关结论**：顾问指出的代码事实**已逐条本地核验为真**（见 §7.1）。**架构方向成立**（round-1 已确认，两轮均未推翻北极星原则），**但 5 个方向在动工前都必须先落实 §7.2 的 6 个收敛阻断修正**。
- **本节为强制约束**：与上文草案 spec（§1–§5）冲突处，**一律以本节为准**。每个实施 PR 仍须按 CLAUDE.md 铁律单独走 Codex+Gemini 验收门。

### 7.1 已核验的代码事实（顾问指控全部成立）

| 指控 | 核验结果 | 锚点 |
|---|---|---|
| `_exec_tool` 是 B-class 同步 tool dispatcher，无 run 状态迁移权，只有 deadline | ✅ 属实。注释明写"B-class backends ARE the runtime…enforced here directly" | backends.py:2798 |
| `_make_worker_event_sink` 只绑 run_id；`_pending_frontier` 按 `status=="completed"`/pending 捞节点 | ✅ 属实，todo 节点入 TaskGraph.tasks 会被执行器捞走 | orchestrator.py:264 / :1495 |
| `/v1/plugins` 返回 `{"plugins": list_registry_plugins(...)}` | ✅ 属实，改信封键/字段名会破坏 Web 契约 | main.py:4790 |
| `state._init()` 先 `PRAGMA journal_mode=WAL` 再立即 `CREATE TABLE IF NOT EXISTS` ~25 张表 | ✅ 属实，迁移 hook 放其后＝备份晚于写库 | state.py:72 / :77+ |
| `events.id` 是**全 DB** `AUTOINCREMENT`，非 per-run 连续 | ✅ 属实，不能当 per-run seq | state.py:86-87 |
| 产品版本硬编码在 `main.py:1444`（`version="0.1.0"`），**非** 1760（那是开发者投递记录字段） | ✅ 属实，方案 C 锚点写错 | main.py:1444 |

### 7.2 六个收敛阻断点（动工前必须修正，含影响 PR）

| # | 阻断点 | 双方裁决 | 强制修正 | 影响 |
|---|---|---|---|---|
| **1** | **D1 在 `_exec_tool` 内联同步阻塞等审批 → worker 死锁/预算耗尽**（最强共识） | 都判致命 | **严禁内联阻塞**。改为：抛 `EscalationPending` → orchestrator 暂停 run 进 `WAITING_FOR_HUMAN_GATE` → resume 重入；**无 UI 时直接 fail-closed deny**（不静默放行）。B-class 在 `_exec_tool` 只负责"判定需人审→raise"，不持有等待。 | D1/D2 重构 |
| **2** | **B3/C 反回滚 watermark 落本地裸文件 → 删文件即重置，反回滚形同虚设** | 都判不通过 | watermark **落 `state.db`**（受 schema/事务保护）+ CAS；裸文件只防网络回滚不防本机篡改。多会话共享 checkout 需 CAS+字节校验（见 [[shared-checkout-commit-race]]）。 | B3/C2/C4 |
| **3** | **B4「同 id 异签整体排除」= DoS**（放个同名本地包即让官方包消失） | 都判不通过 | 改**按 authority 选胜者**：官方 > 委托开发者 > 本地，**仅 quarantine 冲突方**。**只有**同 authority 同 id+version 但 digest 不同、或两个开发者无 transfer 记录争同 id，才整体排除。复用现有 projection「按 id 取最高版本再 gate」(plugin_runtime_projection.py:95/:144)。 | B4 |
| **4** | **A2 信任原语提取未证明零行为漂移** | 都判必须证明 | digest 算法**字节级对拍**（path 排序 / `relative+NUL+bytes+NUL` / 置空 `provenance.package_digest+signature` / `sort_keys=True` / `separators=(",",":")`，plugins.py:93/:249）；**缺 provenance 必须保持抛错（fail-closed），不得静默改友好错误**。`PackageTrustVerifier` 只做 digest/签名/revocation，`validate_manifest_configuration_contract` **留在 plugin 域**。company 的 identity/revocation/local-dev trust 全部 **kind-scoped**，**不得复用** `SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST`。保留 integrity 不查 revocation、每次 use 单独查 revocation 的拆分。 | A2/A3 |
| **5** | **E6 normalizer 直接置 todo 节点 `status=completed` → 越权 orchestrator 状态机；todo 节点污染可执行 frontier** | 都判不通过 | normalizer **只提交进度更新（progress），严禁直接改 `status`**，状态由 orchestrator 裁决。todo 节点必须 `executable=False` 或在 `_pending_frontier` 显式排除 `node_kind=="todo"`，**只展示不调度**。runtime.todo 必须随 `parent_task_id/attempt_index/backend` 走 **task-scoped sink**（现 sink 只绑 run_id，并发 frontier 会挂错 parent）。 | E6 |
| **6** | **C4 迁移顺序写反 + WAL 备份不完整 → "以为有回滚实则旧库已被改"** | 都判不通过 | 迁移 registry 必须**接管 v0→v1 的 CREATE/ALTER/INDEX**，并在**任何 schema 写入前**备份；当前 `_init()` 已先写 schema，方案把 `run_migrations` 放其后是错的。WAL 下**用 SQLite backup API**（或证明 checkpoint+无并发写），简单 copy 会漏 `-wal` 最新提交。`apply` 前**二次 preflight** + token 绑 sequence/sha256/channel/state-snapshot/schema/nonce/expiry（防 TOCTOU）。 | C3/C4/C5 |

**另需修正的事实性/一致性问题**：
- **模块命名不一致**：方向一用 `trust.py`，方向二假设 `package_trust.py` —— 统一为一个模块名（建议 `trust.py`）再拆 PR。
- **C 版本锚点**：产品版本是 `main.py:1444`，不是 1760；`sync_versions.py` CI 闸门必须覆盖全部 6 处版本镜像。
- **release 验签根**：必须用独立 `SUPERCLAW_RELEASE_ROOT_PUBLIC_KEY`，**与 plugin 根公钥分离**（跨域信任污染违反护栏 1）。可共享 TUF root 但 release 走独立委托 target。
- **E1 seq**：`events.id` 是全 DB 自增、不能当 per-run seq。**要么新增 per-run `task_seq`/`run_event_seq`（推荐，正确）**，要么把表述降级为"best-effort live hint"并配"断线/跳变即全快照 reconcile"。不得自称 sequenced TaskEvent 却用全局 id。
- **D5 暂不实施**：在 Codex app-server request handler 内挂起等票据会让外层 timeout/cancel/retire 停摆（codex_app_server.py:616 现立即 respond/decline）。**D5 必须等异步 approval broker（D1/D2）到位后再做**，且 UI 不得扩大初始 sandbox（尤其不得把 `permissions/requestApproval` 升成 network/full）。

### 7.3 逐方向开放问题裁决（合并两路 + 主代理对分歧的裁定）

**方向一**：Q1.1 缺 provenance **必须 fail-closed 抛错**（不得静默）；digest 字节级对拍。Q1.2 verifier 纯加密原语，不碰 roles/tools/configuration 契约。Q1.3 revocation/cache key **必须含 `kind:` 前缀**物理隔离。Q1.4 company 用**独立** local-dev 开关，不共享 plugin 的。Q1.5 保留 integrity/revocation 的按需拆分。Q1.6 **只镜像 envelope（provenance/source/commerce/semver），不镜像 acceptance（tests/evidence_fixtures）**，否则 company loader 找不存在字段崩。Q1.7 `discovery_only` 在**内核层强制剔除** install/run/entitlement 字段。补：明确 `.superclaw/registry/` 下 plugin/company 子目录物理隔离。

**方向二**：Q2.1 命名空间/冲突判定**收敛到 `derive_trust_state` 单一定义点**，loader 只消费其 `reasons`（防定义点漂移）。Q2.2 **选「官方/开发者优先」**（见阻断点 3，不骑墙）。Q2.3 high-risk **不止 commerce/network**：未知权限、filesystem 系统目录写、secret/env、browser/login/payment、外部 sidecar 默认 high-risk。Q2.4 developer 态**保持严苛**（无委托名单即无 developer trust，不推用户开 local-dev）。Q2.5 watermark **落 state.db 事务 CAS**。Q2.6 B6 resolver 投影**必须 per-process 缓存**。Q2.7 company **契约显式标 `instantiable:false`**。补：与现有 `MAX_OFFLINE_GRACE_SECONDS`(plugin_cloud.py:21) 协调，避免两套过期逻辑矛盾。**B6 死守字段兼容**：不得把 `package_digest`→`digest`、`{"plugins":...}`→`{"items":...}`，逐字段快照比对。

**方向三**：Q3.1 apply 前**二次 preflight（同步）**+ token 单次消费。Q3.2 迁移失败**强制阻断启动**并暴露"需人工干预"状态 + **回滚即还原 DB 快照**。Q3.3 plugin-install 用**独立锁命名空间**（不复用 workspace_locks 混语义）。Q3.4 watermark **入 state.db**。Q3.5 pip 路径 `bundled_core/desktop_shell=None` 时**按安装形态分流**，跳过桌面专属检测。Q3.6 v0→v1 baseline **显式对齐**，不裸依赖 `IF NOT EXISTS`。Q3.7 release 与 plugin **根信任分离**，可共享 TUF root + 独立委托 target。

**方向四**：Q4.1 **严禁内联阻塞**，抛 `EscalationPending`+挂起+resume（阻断点 1）。Q4.2 SSE **仅推 `request_id`**，详情走受控 GET（防跨 session 泄露），按 session/company/workspace scoped。Q4.3 CLI respond **必须带票据/principal**，"同机即授权"在多用户机上是提权，admin override 必审计。Q4.4 `write_file` 改敏感路径（`.git/hooks`、可执行入口、CI/package scripts、credential/config）**必须升迁**。Q4.5 fingerprint 加 `last_action_id`。Q4.6 Codex 挂起**必配 heartbeat**否则 sandbox 超时回收（→ D5 延后）。Q4.7 governance 校验调 `fusion` 的权限/entitlement 校验器（**不是**复用旧 `decide_approval` 而绕过票据）。补：`EXPIRED` 状态由谁触发（建议懒检查 + 后台定时双保险）需在 D1 定清。

**方向五**：Q5.1 seq 脆弱——**新增 per-run seq**（推荐）或降级表述 + 跳变/断线全快照 reconcile。Q5.2 **强制 task-scoped sink**，禁全局 sink 混入。Q5.3 normalizer **只提交进度，严禁改 status**（阻断点 5）。Q5.4 **E7 plan-only 剖出延后 P2**（避免空洞五词大纲）。Q5.5 收 `task.*` **显式取消 pending 防抖 timer**（防单行被旧快照覆盖）。Q5.6 核对 `TaskNode.from_dict` 全实例化路径无透传依赖。补：Web 合并用 `setSelectedRun(prev => ...)` 防 React 闭包竞态；Codex plan item 类型名 `{plan,todoList,taskList}` 是猜测，**落地前必须用真机 app-server transcript 核对**。

### 7.4 修正后「可安全起步」清单（吸收上述修正后）

- **A1**（改名+三tab骨架）：纯表现层，零内核风险，**修正后即可起步**（仅需 grep 全量核对 en+zh 词典）。
- **E1+E2**（live todo）：**必须先解决 seq（新增 per-run task_seq）+ todo 节点不污染 frontier（executable=False）**后再起步；否则降级为 best-effort hint 并写明。
- **D1**（提权地基）：**必须以 `EscalationPending`+暂停+resume 模型**实现（不是内联阻塞），无 UI fail-closed deny；这是方向三/五人审确认的前置。
- **A2**（信任原语提取）：**必须带 old/new digest 对拍 + 缺 provenance fail-closed + 干净进程验证**（PYTHONDONTWRITEBYTECODE=1，见 [[pyc-mtime-mutation-trap]]）后方可合入。
- 其余（B/C 内核地基）按 §0 顺序推进，逐项落实 §7.2 修正。

**结论**：本方案经两轮双顾问对抗验证 + 主代理代码核验，**架构成立、方向可实施**；上述 6 阻断点 + 事实性修正为**动工前置条件**，已全部写明可直接据此开 PR。

---

## 8. 机制细化（第三轮：用户 5 问的具体答案 + 真实代码核查 + 第三轮把关）

> 本节回答用户对生态机制的 5 个细化追问。**5 路 agent 已对真实代码做 ground-truth 核查**；两个安全敏感设计（权限混合、提交信任边界）经 **Codex+Gemini 第三轮**对抗把关，结论已并入。**净效果：用户对"过度复杂"的质疑大部分成立——更新、todo 大幅简化，权限澄清为"软 UX + 硬门"混合。** transcript 落 `.codex-cli-advisor/`(roadmap3)、`.gemini-cli-advisor/`(roadmap)。

### 8.1 来源分类法 + 线上承载 + 安装链路（用户问 1）

四来源 → 具体承载体（含真/桩核实）：

| 来源 | 承载体 | 现状（file:line） |
|---|---|---|
| 线上·官方 | HTTP registry（clawhunt.store）做**目录/发现+治理**(entitlement/revocation/policy)；字节走**内容寻址 CDN / GitHub Release 资产**(按签名 digest) | registry 端点现 **404 未接**；信任靠 Ed25519 根密钥签名**不靠主机** |
| 线上·开发者 | **GitHub Release 资产**当签名制品 CDN(零成本 v1) + registry 登记，用**独立开发者密钥层**(区别官方 root) | `install-github` 已 90% 可用，但目录硬编码 `GITHUB_PLUGIN_CATALOG`(main.py:543)，加包要改代码重部署 |
| 线下·非开发者本地自装 | 磁盘 **签名 `.scplug`** | ✅ `/api/plugins/install-local` / CLI `plugin verify`，全签名校验 |
| 线下·开发者本地 | 同上 + `SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST=1` | ✅ 放行不可验签名但**不放松 digest/manifest/revocation**(plugins.py:313)，默认 fail-closed |

- **承载体定论**：非"GitHub vs HTTP registry"二选一——**HTTP registry = 目录/治理面，CDN/Release 资产 = 字节面**。在线安装链：`registry 解析 kind:id@version → 受信签名资产 URL → 下载 → 内核验签+digest+revocation → 缓存 → 安装`。现有 `install-github` 已是这条链 90%，只需把目录源从硬编码 list 换成 registry 响应。
- **⚠️ 铁律违规（必修）**：`install-github` 真在线安装能力**只在 API/Web，CLI 没有**。必须先把 GitHub/registry 的下载+验签+缓存搬进内核函数、暴露 `superclaw plugin install --from github|registry`。

### 8.2 提权弹窗 + 权限系统真相（用户问 2，**安全敏感**，三轮把关）

**权限系统真相（已逐 backend 核实）**：`ask`/`allow` **真生效**于 claude(`--permission-mode acceptEdits`)/codex(`--sandbox workspace-write`)/codex-app-server(ask 自动拒命令)/clawwork(`--tools` 去 bash 硬界)/cursor/hermes；**假/相同**于 grok(两边同)/**B 类 gemini-agent+anthropic-agent**(ask==allow，`_exec_tool` 只在 posture==readonly/plan 拦截，两 preset 都不映射 plan，permissions.py:131 / backends.py:2798)/bobo/local。**真 fail-closed 治理在 `fusion.py` human_gate(扫描/主动网络，preset 无关，fusion.py:896)+ 支付不在默认路径 + 插件信任链，不在这个 preset。** 代码已有软规则注入且自注"prompts are guidance, gates are law"(agent_prompt.py)。

**用户提议（全 allow-all + 纯 prompt ask）裁断：部分对，必须改为"软 UX + 硬门"混合**。两路第三轮一致裁定：

- **软层（用户的 prompt 思路，纯 UX，绝不挂授权）**：扩展 `agent_prompt.py` 定义**标准化 ASK 信封结构**，agent 自识别敏感意图时 emit、前端统一渲染"文本+N 按钮"。给所有 runtime（含无原生 ask 的）一致 ask UX。**但软 ASK 只用于"渲染请求"，模型可伪造"已批准"字段/拆步/改 payload，绝不能进入授权判断**——授权只读后端审批记录。
- **硬门（永不依赖 prompt）**：
  1. fusion human_gate（扫描/主动网络）不变；支付不在默认路径 + 插件信任链不变。
  2. **B 类 `_exec_tool` 补真门——白名单制，非黑名单**（两路共识，关键）：`shell=True` 任意命令、repo cwd 非沙箱、靠命令串识别外联不可靠（`base64` 解码执行防不胜防）。正确做法：在 `plan/default/acceptEdits/auto/unknown` 下**直接不执行 `run_shell`/网络**，强制返回 backend 生成的 pending approval（等价 `EscalationPending`）+ 停止执行；`write_file` 至少受 workspace path + approval artifact 约束，触碰 `.git`/`~/.ssh` 等保留目录强制提权。**`unknown mode → workspace` 是 fail-open，改成 deny mutation。**
  3. **不把已真生效的 runtime（claude/codex/codex-app-server/clawwork）翻 allow-all**（否则删现有真 enforcement = 安全回归）。
  4. **审批 artifact 必须绑** `run_id/session_id/tool_name/args_digest/requester/expiry/decision/approver`，单次消费，payload 改一字节/过期/跨 run 重放/重复消费全拒。
- **codex-app-server（唯一有真交互通道）**：把原生 requestApproval 回调（commandExecution/fileChange/permissions/elicitation，codex_app_server.py:621）从"policy 自动应答"改为**路由到标准化前端 ask 接真人审**；**默认 decline**，超时/断线/未知类型一律 decline 或 pause、**绝不自动 accept**。
- **是否需 prompt 引导**：是——硬门是 enforcement（runtime 无关），软 ASK 是 prompt 引导的统一 UX；不同 runtime 格式差异：多数 runtime 由 SuperClaw 注入统一格式（天然一致），唯一有原生格式的 codex-app-server 做归一化。
- **fail-closed 判定**：revised 混合作为目标架构**通过**；但"B 类补真门 + codex-app-server 人审接线"**未落地前不是 fail-closed**，这两项是动工硬前提。

### 8.3 开发者提交 → 官方审核 → 发布（用户问 3，**安全敏感**，三轮把关）

**现状（已核实）**：**无官方审核阶段**；submit 端点仍收请求体 `signing_private_key`、自动门过后**内联签名**并返回 `status=verified`(plugin_submission.py:177 / main.py:4710)；certified/l3 硬编码 False；发布=手改 `GITHUB_PLUGIN_CATALOG`；审核签名者与官方 root 签名者**脱节** → **今天"任意密钥即铸 verified"是硬阻断绕过**。

**架构（两路第三轮收紧后）**——核心不变量：**审核状态机与签名权限必须分离；submit 永不内联签名；签名服务隔离**：
1. **submit 只上传 immutable blob + 算 digest**（CLI `<kind> submit`，plugin/skill/company）；**移除 `signing_private_key` 字段**（旧字段传入直接 400）；review worker **无签名密钥**。
2. **审核记录隔离**：新增隔离的 `artifact_release_review` 记录类型，绑 `kind/id/version/developer_id/package_digest/gate_snapshot/manual_requirements/allowed_audience`。**与 workspace-team 的可篡改权限分离**（Gemini：独立 `OfficialSubmissions` 域；Codex：至少新类型+绑定且签名分离——两者实质同：本地团队权限不得篡改审核记录去骗签名）。
3. **签名服务带外/隔离**：API/CLI **无生产签名密钥**；签名服务只收 `approval_id`，**自己从 blob store 取 bytes 重算 digest、确认 approval=approved 且 digest 精确匹配**，再用 KMS/HSM online key 签，记录 `signature/key_id/review_id/signed_at`。offline root 委托 online signing key（沿用 [[plugin-trust-chain-hardening]]）。
4. **registry 发布**只接受签后且复验通过的 artifact；**禁手改 catalog 当生产发布**。
5. **`trust.py` 硬断言**：只有 `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` 验过 → `official`；其余密钥最多 `developer`/`local`；`LOCAL_DEV_TRUST` 只产 local/dev，**不得进官方 registry/high-risk install**。
6. **skill**：免费复用（已是插件投影），加 `skill submit` 动词，只走信任信封不跑错 plugin runtime gate。**company**：新建 `CompanyTemplate` 格式/schema/审核模块；submit **validate-only**，实例化必须 **签名模板 → proposal diff → `resolve_equipment` 交集 drop 未授权装备 → budget clamp → reports_to 无环 → 高危 permission/policy 逐项人审 → commit**，导入审计存 template id/version/digest+approval id+dropped equipment+budget clamp 结果。
- **遗漏补**：吊销生命周期（恶意组件如何官方吊销 + 客户端强制同步 revocation）必须与发布同期设计。

### 8.4 App 更新——大幅简化（用户问 4，用户正确）

**用户对**：Tauri v2 自带一键流程（显示更新→下载→验 Ed25519 签名→安装→重启），免费。复杂只因 (a) updater 从没启用；(b) 旧 Direction-3 想在 Python core 重造整条管道（多维版本契约+第二层签名 manifest+apply-token 编排），**重复 Tauri 已有验签 = 过度工程**。

**简化方案（取代 §3 的 core-governed orchestrator）**：
- ✅ **启用 Tauri 原生 updater + 签名密钥 + `latest.json` + CI** = 一键体验，够了。
- ❌ **砍掉 v1**：多维版本契约、第二层签名/反回滚 manifest、core apply-token 编排。
- ⚠️ **只保留两个便宜且必要的安全底线**：(1) 更新前 gate——有 run 在跑/人审挂起时**不替换**（复用 `liveness.py:67` 单一判活源；整 app 替换会毁进行中证据/状态）；(2) 改 schema 前**备份 state.db + 加 `PRAGMA user_version`**（现零 schema 版本）。
- **真正工作量 = macOS 公证**（Developer ID 签名+notarize+staple，在 `prepare-macos-bundle.mjs` 重签之后产出 updater 工件）接进 CI——这是 CI/notarization 任务，**不是 Python 编排任务**。Tauri 更新签名密钥 ≠ Apple Developer ID 身份，两套密钥别混。

### 8.5 todo 用 prompt 注入——更简单更兼容（用户问 5，用户正确）

**用户对**：prompt 注入比改造 orchestrator TaskGraph 更简单更兼容。关键事实：**纯 direct-chat 根本没有 TaskGraph**（`/api/chat/stream` 走 `adapter.run_turn`，没建 run session），改造方案得为聊天硬造合成图；prompt 方案 runtime 无关、每个 backend 都能用，零 schema/事件改动，避开双路 emit 坑。

**设计（取代 §5 的 ExecutionGraph 重型方案作为 MVP）**：
- 注入**最小、flag 门控**的 prompt 让 agent 回答前 emit 标准化 todo 块；**core 里的 normalizer**（`chat_turn.py` 邻接，**不是前端**）**纯容错解析**（缺失/畸形→None，**绝不抛错**）成 canonical todo 结构；前端只渲染预归一化结构。
- **纯展示，绝不进调度/门控**；turn 成败只看 `turn_result`，**没 todo 就没列表、不报错**（用户要的容错）。
- 解析归一化**必须在 core**（CLI 唯一事实源，[[unified-task-entry]] 禁前端映射）；emit 进 §5(A) 定义的**同一 canonical 结构 + ui_contracts status_tone**，将来交付型 run 要更结构化时 A 可无缝接管。
- 流式半截行容错：只在 `message.completed` 解析或尾部容错（只 emit 完整行）防抖动。注入片段最小化、flag 门控，保 [[unified-task-entry]] 的"chat=原生 runtime turn 原文透传"语义。
- **诚实取舍**：这和 Claude Code/Codex 内部不同（它们读结构化 tool-call payload TodoWrite/plan），prompt 方案用"结构化保证"换"全 runtime 兼容"，对侧栏 MVP 是对的取舍。

### 8.6 第三轮裁断小结

| 用户问 | 裁断 | 对原方案的影响 |
|---|---|---|
| 1 来源/承载 | 四来源映射明确；HTTP registry(目录)+CDN/Release(字节)；修 CLI 缺 install 的铁律违规 | 细化 §1/§2 |
| 2 权限/提权 | **软 ASK 纯 UX 不挂授权 + B 类白名单硬门(不执行 run_shell→pending) + codex-app-server 默认 decline 接人审 + 不翻 allow-all + 修 unknown→deny** | 收紧 §4(D) |
| 3 提交审核 | **移除内联签名(signing_private_key→400) + 签名服务隔离(只收 approval_id 重算 digest+KMS) + 审核记录与签名权限分离 + trust.py 硬断言 root→official** | 新增，接 [[plugin-submission-approval-signing]] |
| 4 更新 | **大幅简化**：Tauri 原生 updater + 2 个最小 guard + CI 公证；砍 core 编排 | **取代** §3 主体 |
| 5 todo | prompt 注入 + core 容错 normalizer + 纯展示 + 同 canonical 结构 | **简化** §5 为 MVP |

**总结论**：用户的简化直觉在更新、todo 上完全成立并已采纳；权限与提交因涉 fail-closed 治理，简化为"软 UX 统一 + 硬门隔离"的混合，而非"纯 prompt"。三轮把关后，方向与机制均已 fail-closed 可实施。

---

## 9. 付费 / 加密 / 上传 / 热更新 / 后台管理（机制可运行性核实 + 设计）

> 用户追问：① 现有"付费 + plugin 加密 + MCP 统一 proxy"机制是否正确可运行？② 开发者上传机制（能传什么/不能传什么）？③ 热更新逻辑（何时更新/性能最佳实践）？④ 能力工坊前后台管理是否最佳实践、如何安全稳定可靠？
> **5 路 agent 已 ground-truth 核查真实代码，主代理已本地复核 3 个载荷事实**（entitlement 门序 / 无加密 / revocation 未签名）。

### 9.1 机制可运行性核实（先确认基础——用户首要诉求）

| 机制 | 状态 | 核实结论（file:line） |
|---|---|---|
| **MCP 统一 proxy（正常签名插件）** | ✅ **完全可运行** | `invoke_cached_plugin_tool`(plugin_proxy.py:106) 是唯一权威门栈，**每次调用**严格顺序过：包加载→`verify`(签名+digest)→**revocation 每次重查**(mid-run 撤销仍生效)→tool 声明→**entitlement**→runtime policy→config→sandbox preflight→sidecar 启动→输出脱敏/预算/schema 校验。enumeration 门与 execution 门**复用同一组函数**(纵深防御)。dispatch 无 fail-open 洞。 |
| **付费 / entitlement** | ⚠️ **门是真的，商业闭环是桩** | **门真实 fail-closed 且在 sidecar 启动前**：`_resolve_entitlement`(plugin_proxy.py:157) 在 `_run_sidecar`(:208) 之前；付费插件无 entitlement → `PLUGIN_ENTITLEMENT_MISSING` 拒于启动前；含 72h offline-grace。**但背后是 fake-cloud 桩**（plugin_cloud.py:205）：无真实购买→发权、**无执行期设备绑定**(entitlements.json 跨机可移植，:339-368 不校验 device_id)、**无运行时计量计费**(plugin_proxy 不发 CostEvent)、token 只是明文 SHA256(可手改)。真开发者商业仅 `{free,private_beta,paid_manual}` 手动结算。 |
| **plugin 加密** | ❌ **完全没有（absent）** | `.scplug` 是**明文签名 ZIP**：`load_plugin_package`(plugins.py:71) 就是 `zipfile.ZipFile`+解压，全包 grep `decrypt/AES/cipher` **零命中**。**MCP proxy 今天只能解析运行明文包，不能解析运行加密包**。记忆里"加密分发"是方向、无代码无 spec（仅有 TOCTOU 加固说明）。`secrets_store` 的 AES-256-GCM 是给**凭据**用的，不是包字节。 |

**直接回答你的问题**：
- **正常明文签名插件**——✅ 能正常解析、运行、被 MCP 统一 proxy 代理，且治理门栈完整 fail-closed。
- **付费插件**——✅ entitlement 门真能拦（无权→启动前拒），但"真实付钱→发权→设备绑定→计量"是桩，要补真后端。
- **加密插件**——❌ **现在不能**。要支持需在 `load_plugin_package` 插一个 decrypt 步骤（detect 加密容器→decrypt 到 BytesIO→喂给现有 zipfile，digest/签名仍算在**解密后明文**上，下游字节不变）。**关键门序问题**：今天 entitlement 门(:157)在 load+verify(:133-151)**之后**，若 load 期 decrypt 会跑在 entitlement 之前——**付费+加密插件必须把 decrypt（或解密 key）移到 entitlement 门之后**，否则未付费也解了密。缓存今天存明文，加密至rest 还需决定是否加密缓存。

### 9.2 上传机制（用户问 ②：能传什么 / 不能传什么）

**现状**：只有 **plugin** 有上传路径；**skill** 经 `import-skill` 包成 plugin 再走同路径；**company 完全没有上传/pack/template**。产物 = `.scplug`（明文 ZIP）。`plugin submit`(plugin_submission.py:150) 跑 ~20 个 fail-closed 门后**仅本地签名**，记录落本地、**不出本机**；API 端点接的是**服务器本地文件路径**而非 multipart blob 上传。

**已强制拦截（不能传）**：非 `mcp_sidecar` runtime / 非 stdio / 通配网络 host `*` / 直接索要 root LLM key(ANTHROPIC/OPENAI/…) / 内嵌密钥或类密钥串 / 权限↔secret 描述符不符 / 运行时下载代码(`curl|wget|sh`、`pip install git+`) / smoke 测试失败或超时 / 缺必备文档(LICENSE/SECURITY/SUPPORT/PERMISSIONS/CHANGELOG) / 不安全 entrypoint 或 `..` 穿越 / 归档含 symlink / digest 不符或非 sha256 / 关键级 SBOM 漏洞 / 超资源上限 / 自封 L3/Certified。
**缺/弱（必补）**：① 无隔离签名服务、无服务端审批门、无不可变制品库、无真网络上传（只接本地路径）；② **`.scplug` 无大小上限/无 zip-bomb 解压比上限**(plugins.py:277 无 size/ratio 限制)；③ secret-scan / code-download 是**正则启发式非真 AV**；④ 不产出 audience/可见性/entitlement/revocation 状态。
**完整上传契约（后台审核要收的）**：不可变 blob(`artifact_blob_digest`+`package_digest` 双 digest) + schema 校验过的 manifest + tool schema + provenance(签名) + 身份/受众(developer_id/id/version/**audience: private/unlisted/limited/public**) + tests/evidence + 绑定到精确 digest 的门结果摘要 + 必备文档。**真上传必须改成 multipart blob POST**。
**company 上传**：需新建 `CompanyTemplate` schema + pack——内容 = company 默认(预算/allowed_plugins 引用/high_risk_policies) + 一组 AgentProfile 角色定义及其 charter + workspace/repo 绑定意图——走与 plugin 同样的 blob+manifest+provenance+audience 审核契约。

### 9.3 热更新机制（用户问 ③：何时更新 / 性能最佳实践）

**现状**：**任何层都无缓存**。Web `loadPluginControl`(App.tsx:5321) 在加载 + 身份变更 + 每次装卸 + 手动刷新时**无条件重拉整个目录**(6 端点)；服务端 marketplace 拉取是**阻塞 8s httpx 直通无缓存**；revocation 表**未签名、无新鲜度**。

**最佳实践（直接回答"每次打开都热更新吗？"——不，整目录每次开都重拉是错的）**：
- **(a) 缓存索引 + 短软 TTL(5–15 min)**：落 `.superclaw/registry/`，打开工坊**先秒渲缓存、后台再 revalidate**(stale-while-revalidate)，**开屏不阻塞**。
- **(b) 条件 GET / ETag**：服务端发 ETag+Cache-Control、转发 If-None-Match；304 只几字节 vs 整目录。
- **(c) 签名时间戳新鲜度 + 单调 sequence + 24h expires_at + 客户端 watermark**(反回滚)：这才让"不每次重拉"**安全**——只在签名时间戳新鲜时信缓存（承接 §方向二 TUF）。
- **(d) 后台刷新**：单个低频定时器或 SSE 推一下，**永不阻塞渲染**(SSE 仅通知非权威)。
- **(e) ★ revocation 快路径（唯一必须及时的）**：把吊销从笨重目录**解耦**成一个**小的签名 revocation+时间戳 blob**，自己的短 TTL；过期/拉取失败 → 付费/高危插件 **fail-closed 拒载**、普通插件软警告。
- **为何这样分**：发现层新鲜度低风险（安装永远重验签名+digest，install-github 下载后还重校 id/version/digest main.py:2840），故大目录可激进缓存；**吊销/kill-switch 高风险 → 给它独立的小型、高频、fail-closed 通道**，几分钟内传播。每次开都重拉整目录在安全关键路径上**毫无收益**、只增延迟带宽。

### 9.4 clawhunt 后台审核管理（用户问 ④：是否最佳实践 / 如何安全稳定可靠）

**现状：后台是 designed-only**。薄的开发者提交 intake 存在（`POST /v1/developer/plugins` 建记录、`/artifact` 跑本地门），但 **approve/审核队列/认证名单/签名目录发布/管理 UI 全部 out_of_scope**。"每日提交→站长审批→认证名单→发布"闭环**未建**。

**安全架构（应当建成，接 [[plugin-submission-approval-signing]] + §方向二 + §8.3）**：
1. **不可变提交库**：上传即算 `artifact_blob_digest`+`package_digest`，字节不可变存储；**上传/审核进程无签名密钥**。
2. **审核队列**：自动门 worker（manifest/secret-scan/SBOM/MCP-schema/smoke/pricing）**无签名密钥**、结果绑精确 digest；风险分类器把高危（新权限/商业/L2/L3/二进制载荷）路由到**人工审批队列**——这就是站长"今天进了什么"的每日视图。
3. **隔离签名服务**：approve→`ready_for_signing` 绑 `{submission_id,id,version,developer_id,package_digest,granted_level,allowed_audience,approver,ts}`；**独立 KMS/HSM 服务从存储字节重算 digest、仅精确匹配才签**；审核/上传/web 进程永不持密钥。**双钥层级**：离线 root 签"角色/密钥集"声明当前 online key；online key 签目录/票据/吊销——**每日审批不碰冷 root，online key 可轮换无需客户端更新**。
4. **签名目录发布**（与签名分离）：发布 = 把 approved `{kind:id:version:digest}` 加进官方认证 targets + bump 单调 sequence + online key 签目录/时间戳；**audience 分级灰度**(private_beta→public) 让站长能金丝雀再 GA。
5. **吊销**：digest 级紧急吊销 + 版本 + 开发者/key-id 粒度，签名，带 sequence+expires_at。
6. **审计**：上传/审核/审批/签名/发布/吊销 append-only 日志。

**审批如何热更新传播（客户端侧）**：客户端只刷**签名目录 targets** + 小型签名 revocation blob，**不碰后台**。站长 approve → online key 签 sequence+1 的 targets → CDN 服务 → 客户端下次后台 revalidate 见更高 sequence、过反回滚 watermark、新认证条目带**官方徽章出现——无需重装**（徽章由验证推导非 manifest.source）。因发布只改签名索引、安装仍本地重验签名+digest，**热更新路径即使目录被缓存仍安全**。

**是否最佳实践？—— 地基稳但未达标，5 个 must-have**：
- ✅ **强项**：安装路径是真正硬化的信任边界（install-github 下载后重验 Ed25519+id/version/digest、不符即回滚 main.py:2840；entitlement offline-grace 对付费/高危 fail-closed）。
- ❌ **必补**：(1) 目录缓存/ETag/TTL/SWR；(2) **给 revocation 表签名 + 新鲜度 + 付费 fail-closed**（**单个最大安全缺口**，revocation 现未签名 trust-chain doc:330）；(3) 反回滚 watermark；(4) 后台审批/签名/发布闭环 + 隔离 KMS 签名；(5) 命名空间硬隔离（保留官方前缀、同 id 异签硬冲突）。
- **必守不变量**：CLI 唯一事实源（各表层包同一份核心）、网络/签名/TTL/sequence 失败默认 fail-closed、信任徽章由验证推导、权威在 durable store + CLI 快照而 SSE 仅通知。

### 9.5 小结（用户 4 问裁断）

| 问 | 裁断 |
|---|---|
| 付费/加密/proxy 可运行性 | proxy+付费门**可运行**（付费商业闭环是桩）；**加密完全没有**，要补 decrypt 步且对付费+加密要把 decrypt 移到 entitlement 门后 |
| 上传 能传/不能传 | 只 plugin 有路径(skill 经 import-skill、company 无)；~20 门已拦危险项；缺真上传/隔离签名/大小上限/真 AV/audience；完整契约见 §9.2 |
| 热更新时机/性能 | **不要每次开都重拉整目录**；缓存索引+TTL+SWR+ETag+签名新鲜度+**revocation 独立小通道 fail-closed** |
| 前后台是否最佳实践 | 地基稳（安装是硬信任边界），但 revocation 未签名是最大缺口；后台审批/签名/发布闭环未建；5 个 must-have 见 §9.4 |

---

## 10. skill 隐性依赖判别（"works on my machine" / 非 hermetic 打包）

> 用户问：像 Hermes 这种 agent runtime 自带别的 skill，开发者在富环境里测 skill 看似效果好，分不清是 skill 自身还是底层 ambient skill 的功劳；到了别人环境就不可复现。**开发者上传时如何精准打包、用什么判别机制？** 经 Codex+Gemini 对抗评审，两路高度收敛。

### 10.0 现状（已核实，问题当前完全未处理）
- 清单 schema **无任何依赖声明字段**（grep `depend/requires/dependencies` 零命中）。
- skill 验收**极浅**：`import-skill` 只生成 `smoke.sh` 断言 sidecar 把 body 原样回传（skill_import.py:121/255），**零效果评估**。
- 投影**与 ambient skill 共存零隔离**：投进 `~/.codex/skills`、`~/.claude/skills` 等（skill_sync.py RUNTIME_TARGETS），运行时模型同时见所有 skill。
- 已有可复用件：`SUPERCLAW_*_SKILLS_DIR` env override（可指临时目录做隔离）、`sandbox_smoke_run`（干净 PATH 子进程）、`capability_surface.py`（现仅 resume guard，可扩到验收 surface）。
→ **今天开发者和系统都无法分辨 skill 的好效果是自身的还是 ambient 的。**

### 10.1 核心原则
**衡量 skill 在"可枚举、可重放的声明基线"下的边际贡献，而非富环境的绝对表现。** 让隐性耦合要么藏不住（隔离失败暴露），要么变显式（声明依赖）。**可移植性是分级（tier）不是布尔**——诚实标注一个 skill 到底在哪能复现。

### 10.2 判别机制（七要件，已吸收两路评审）

1. **claims-first（声明可审计目标）**：skill 清单必须带 `claims`——能力范围、`target_runtimes`、`target_model_tier`、**不保证事项**。eval 测的是 claim，不是作者挑的样例。无机器可审计 claim → 不能认证。
2. **可移植性分级（核心，回答 Hermes）**：
   - `portable`：只依赖**标准基线 + 显式声明依赖**，clean-room 通过。
   - `runtime-native`：只保证在**指定 runtime + 其 built-in surface**下工作（Hermes built-in 不可移除时的诚实标签）。
   - `unverified`：runtime built-in **不可枚举/不可 digest** → 一律不准标 portable。
   - **跨 runtime 必须各自重跑 clean-room，不能继承**（Hermes 结果不能套到 Codex）。
3. **基线必须可枚举+可重放**：runtime 暴露 `builtins.manifest`（每个 built-in 的 id/version/digest/visibility/是否可移除）。**built-in 当作"隐式 StdLib"必须显式枚举**；不可枚举 → 不给 portable 认证。clean-room 基线 = runtime 通用 built-in（声明的） + 显式 `requires` 依赖，别的都不要。
4. **分级强制（解决冷启动/flaky DX）**：
   - `import` = **只捕获 provenance/surface**（毫秒级、离线可用，不跑 LLM）。
   - `skill doctor --diff`（**v1 的 80/20**）= clean-room vs ambient 跑同一 eval，输出：clean-room 结果 / ambient 结果 / declared deps / **未声明却在场的 ambient skill** / effective surface digest / 推荐分级（portable｜runtime-native｜ambient-coupled｜unverified）。**本地 advisory，不硬拒。**
   - `submit/publish` = **唯一窄硬门**：声明 portable 但 clean-room 失败 → 拒；只在 ambient 通过 → 标 `ambient_coupled=true`，**不准上架为 portable**。**v1 不做通用 LLM-judge 硬 gate。**
5. **evidence-based eval（确定性优先，judge 仅辅助）**：
   - 优先 **deterministic oracle**：结构化输出 / 文件 diff / 工具调用序列 / 必须·禁止关键词 / schema / ground-truth answer。
   - LLM-judge **只用于语义质量项**，且 **N≥5 多样本 + 多 judge + 固定 rubric + 置信区间 + 必须含负例**（证明 skill 不越权泛化）；judge≠被测同模型同上下文（防共振误判）。
   - **fail-closed 于"置信不足 + 关键负例失败"，不是"分数略低"**；judge 失败先标 `needs_review`，只有安全/合规/声明能力核心项**反复**失败才 hard fail。
   - registry 维护一份**包外 hidden conformance eval**（包内 eval 天然可过拟合，只能当证据不能当唯一硬门）。
6. **依赖像代码依赖一样治理**（允许组合，但受控）：清单加 `skill_dependencies[]{id, version(semver range), digest, reason, required}`，**无环、版本+digest 锁定、限层级**；区分 `requires`（clean-room 必装，缺失 fail-closed）vs `suggests`（可增强，但**不能成为通过 eval 的必要条件**）。打包生成 **flattened effective context** 供验收+审计。**鼓励 Base Skills**（如 `json-format-enforcer`）而非每个 skill 重写一遍基调——但禁止隐式 ambient mega-skill。
7. **铁律分层**：
   - **内核**只放纯契约+纯计算：manifest schema、`skill_dependencies` 依赖图校验（无环/版本/digest）、surface fingerprint、result schema。
   - **CLI/submission** 负责执行：用 `SUPERCLAW_*_SKILLS_DIR` 建一次性隔离目录、只投被测+`requires`、跑 eval、收 transcript（**不改用户正常 ambient 目录**）。
   - **LLM-judge = 外部 evaluator adapter**，产出 signed/hashed evidence record，**不是内核真理源**；CLI 据 evidence 决定 gate。UI 只展示 CLI 产物不重新解释。
   - 新增 `skill_verifier.py`（隔离投影 + eval 调度）；`plugin_submission.py` 加门：portable skill 必须有 hermetic evidence；扩 `capability_surface.py` 到验收 surface。

### 10.3 一句话回答"开发者如何精准打包"
**跑 `skill doctor --diff`：它告诉你 skill 在 clean-room 与 ambient 的分差、哪些未声明的 ambient skill 在场、以及诚实分级。** 若只在 ambient 通过 → 标 `ambient_coupled`，你必须**要么把那些指令内联进 skill 正文、要么声明成版本+digest 锁定的 `skill_dependencies`**。一个 skill 是 `portable` 当且仅当它在**可枚举标准基线**下通过；否则诚实标 `runtime-native`（"只保证在 Hermes+其 built-in 上"）。**精准打包 = 包里包含或声明了其效果所依赖的一切，由 clean-room diff 验证、按诚实 tier 分类。**

### 10.4 分期
- **v1（先做、低风险、CLI 事实源）**：claims + target_runtimes + skill_dependencies + baseline_surface 进 schema；`skill doctor --diff`（clean-room 隔离投影 + ambient diff + surface 捕获 + 分级推荐）；submission 窄硬门（portable-claim 但 clean-room fail → 拒；ambient-only → ambient_coupled）。**不做通用 judge 硬 gate。**
- **vNext**：runtime `builtins.manifest` 枚举；deterministic-oracle eval 框架 + 多样本 LLM-judge adapter（signed evidence）；registry hidden conformance eval；依赖一并投影 + flattened context 审计。

**结论（两路一致）**：这套机制**应该做、是 SuperClaw 对抗式验证铁律的延伸、不是过度工程**；但 **v1 不从 LLM-judge 硬拒起步**——先把 portable claim、runtime baseline、dependency lock、surface provenance、clean-room diff 做成 CLI 事实源。**没有可枚举 baseline 和可重放 evidence 的 skill，一律不能标 portable。**

### 10.5 runtime-of-record 背书阶梯（用户精炼："built-in 无法举证就略过"太狠，应记录跑通的 runtime 增容错）

> 用户洞见：built-in 不可枚举时别死胡同/略过，应**记录开发者当时跑通的 agent runtime（如 Hermes）作为证明、推荐终端用户用同一 runtime**，最大化容错。经 Codex+Gemini 第二轮验证：**方向对、确实增容错，但有一个致命点必须修——背书不能是开发者光签的"声明"（信任洗白），必须是签名的可重放执行证据。**

**① 致命点：开发者单方面签名声明 = 信任洗白（两路一致，必须修）**
密码学签名只证明"谁说的"，不证明"说的是真的"。若开发者光签个"我在 Hermes 上跑通了"就绕过独立复现上架 → 黑客/懒开发者会大规模注入不可验证的垃圾/恶意引导，击穿 fail-closed。**修正：基于证据的背书（Evidence-Backed Attestation）**——开发者必须提交由 SuperClaw devkit 在连接目标 runtime 时生成的**不可篡改执行轨迹（transcript：输入/输出/耗时/模型调用）**，签名签在这份 `evidence-fixture` 的 hash 上。registry 虽拉不起封闭 runtime，但能验证该 evidence **确实产自真实交互**（防伪造）。**纯声明无 evidence → 直接拒，连 developer_claimed 都不给。**

**② 背书绑定的是"surface 四元组"，不是"一个 runtime"**（防漂移）
背书对象 = `skill_package_digest + runtime_surface_digest + model_profile + eval_suite_digest`。**runtime built-in/model profile/依赖 任一变化 → 背书失效或降级 stale。** runtime 可能静默热更新（不改版本号）让 skill 默默崩 → `attested` 包必须**捆绑 ≥3 个 replay evidence（smoke.json 录像，覆盖主分支）**；终端用户在同版本 runtime 遇问题时，CLI 用 `sandbox_smoke_run` 本地回放比对，语义偏离超阈值 → 明确报错"Runtime 环境已漂移，背书失效"。

**③ 诚实五级阶梯（替换原 §10.2 的 4 级，两路收敛，Codex 措辞最精确）**
| 级别 | 含义 |
|---|---|
| `portable_verified` | clean-room 标准基线 + 声明依赖通过 |
| `runtime_record_verified` | **SuperClaw CLI/registry 在隔离里重跑过**该 runtime surface 通过（独立验证，窄到该 runtime） |
| `developer_claimed` | 开发者提交**签名可重放 evidence**，SuperClaw **未**独立重跑（可用但明确标"未独立复现"） |
| `ambient_coupled` | clean-room 失败、ambient 通过（不准上架 portable） |
| `unverified` | 无可重放 evidence |
→ **直接回答你**：你的"记录 runtime"想法落地为 `runtime_record_verified`（若 SuperClaw 能复现该 runtime 就重跑认证）或 `developer_claimed`（不能复现但开发者交了可重放 evidence）——**不是死胡同，但也不洗成 portable**。`verified_by` 必须是 `superclaw-cli/registry`，开发者**不能自授 verified**。

**④ 跨 runtime = 按权限 fail-closed（"告警"无用，用户必无视）**
- **硬拒（无 override）**：skill 声明**任何超出 `{filesystem:[],network:[],environment:[]}` 的权限**（带 sidecar/工具能力）且当前 runtime ≠ 背书 runtime；或声明 portable 却只有 runtime-record evidence；或 built-in 不可枚举却称 portable；或缺 `required` 依赖/digest 不符；或含 runtime-specific 指令（"在 Hermes 里你可以…"）却称跨 runtime；或 surface stale。
- **Human-Gate（可显式 `y` override）**：纯零权限 prose skill 跨 runtime → 拦截提示"此指令集针对 X 设计、当前在 Y 运行、效果未验证"，用户显式确认才注入。
- **CLI 是最终裁决**：跨 runtime/高危权限时，终端 CLI 内部验证器**直接硬拒、绝不等云端指令**。

**⑤ 反劣币驱逐良币（防生态全倒向 attested 捷径，两路一致）**
- **分发层**：marketplace 默认**隐藏** `developer_claimed`/低级别（需 `--include-attested` 显式查）；`runtime_record_verified` 只在**匹配 runtime** 默认可装、其他 runtime 显示需验证；`portable_verified` 默认跨 runtime 可装。
- **执行层**：`developer_claimed` 强制 **HITL**——即使自动化 run，命中该级别节点也 `pause_for_human_gate`。
- **排序**：portable_verified > runtime_record(匹配当前 runtime) > developer_claimed > unverified。
- **升级通道**：registry 收到足够多**来自不同用户**的成功执行 evidence（众包验证）→ 自动 `developer_claimed`/`runtime_record` 升级。
- **迁移工具**：`skill doctor --make-portable` 指出要内联/声明依赖/移除 runtime-specific 指令的**具体位置**；官方维护 portable baseline + starter eval 降低开发者成本。

**⑥ 铁律分层（数据落 schema，CLI 是最终事实源）**
- 分级落 `schemas/superclaw-plugin.schema.json`（扩 `acceptance.level`/新增 `portability`）；
- 开发者本地 `superclaw skill submit` 抓本地 evidence、用开发者私钥（relay_key 模式）签 → `provenance.signature`；
- registry 验 evidence 格式+签名有效性 → 决定收录级别（不接受纯口头声明）；
- **终端 CLI（plugin_local_verification.py/plugin_proxy.py）是最终事实源**：读级别，跨 runtime/高危直接硬拒，不等云端；UI 只展示 CLI verdict 不重新推断。

**精炼结论**：你的容错直觉对——**built-in 不可证就把整个 runtime 当黑盒基线、记录可重放 evidence、推荐 runtime 给用户**，skill 仍可用（`runtime_record_verified`/`developer_claimed`）。但背书必须是**签名的可重放执行证据**而非口头声明，跨 runtime 按权限硬拒，且用分发/执行/排序摩擦把生态推向 portable——**容错拉满，又不洗白信任**。

### 10.6 运行时遥测：用"实际触发了哪些 Skill/Tool"做耦合线索（用户思路 + 两路验证）

> 用户思路：既然 skill/plugin 在 Super 体系内跑通，后台 agent runtime 能查到实际触发了哪些 Skill/Tool；把实际轨迹 vs 声明的包内容比对，调用了包外未声明且决定性的东西 → 隐性耦合线索。**经 Codex+Gemini 验证：思路成立，且部分数据已现成；但遥测是"雷达"不是"判决器"，且解法比"证明决定性"更聪明。**

**SuperClaw 实际能观察到什么（已核实）**：
| 触发类型 | 可观测 | 依据 |
|---|---|---|
| 受治理 plugin/skill 工具调用（经 MCP proxy） | ✅ **已记录、防篡改、权威** | 每次调用写证据：`run_id/plugin_id/plugin_version/tool_name/entitlement_id/input_digest/output_digest/artifact_id`（plugin-invocation-evidence.schema.json）。**skill-origin skill 靠调用其 proxy 工具加载**(skill_import.py:11)→skill 激活也是被记录的工具调用 |
| runtime 原生工具（shell/文件/原生 MCP），codex-app-server & claude | ✅ 可观测（事件流） | codex-app-server notification 队列 + tool_iterations；claude stream-json `tool_use`/`tool.*` |
| **ambient 纯 prose skill**（runtime 自带/直接丢 ~/.codex/skills 没走 SuperClaw） | ❌ **盲区** | 纯 prose 是 context 注入非离散工具调用，proxy 看不见 |

**裁断后的设计（两路收敛）——遥测做"声明校验+雷达"，不做"判决"**：

1. **核心解法：不证"决定性"，改做"严格声明校验"（Gemini 洞见，解开死结）**
   - 自动消融证决定性 = O(N) 次完整 LLM 跑、LLM 随机性让方差大到不能当 gate → **放弃**。
   - 改为：Layer 1 遥测**只做合法性审计**——run 里触发了**任何**未在 `dependencies` 声明的包外 tool/skill（proxy 证据 + runtime tap 捕获）→ `submit` **直接 fail-closed**："检测到未声明外部调用 X，请加进 dependencies 或改 prompt 阻止它"。**"是否决定性"的排查成本推回开发者**（内联或声明），框架不跑昂贵消融。
   - 遥测只输出 `suspicion`/`needs_reverification`，**绝不自动写 dependencies、绝不因 ambient 通过授予 portable**。

2. **v1 实现极简（Gemini，零新协议守铁律）**：`skill submit` 时 CLI 本地**只读** `state.StateStore`(SQLite) 里已记录的调用 + runtime tap，跑 `set(invoked_tools/plugins) - set(manifest_tools ∪ declared_deps)` diff；非空 → **exit 1 阻断提交**。**纯 Local CLI 对 Local DB 只读，无 daemon、无云请求、无消融。** 落 `state.StateStore` + `evals.py`/新 `skill_verifier.py`，不动 proxy 加云逻辑。

3. **prose 盲区：遥测诚实致盲，唯一兜底是 clean-room + 静态 lint**（两路一致，最大风险）
   - 恶意开发者把关键逻辑写进本机 `~/.codex/skills/hack.md` → Layer 1 遥测变瞎子。**遥测不假装看得见、不当这层的安全防线。**
   - **唯一兜底 = clean-room 用 `SUPERCLAW_CODEX_SKILLS_DIR` 挂到绝对空临时目录**，物理上让 ambient prose 消失；偷偷依赖必在 clean-room 降级/崩溃。
   - 加 **静态 prose lint**（`prose_dependency_lint`）扫依赖暗示词（"as usual / existing policy / built-in / company standard / follow the framework"）+ manifest `self_contained: true|false`；声明 true 却引用外部 prose → hard fail。

4. **本地轨迹 = Zero Trust，不能硬 gate**（两路一致）：开发者有 root，可拦 SQLite 写、改 proxy 返回、篡改 evidence.json。本地轨迹只配 `developer_claimed`/`local_attested`（开发者签名宣誓书，审计价值非最终信任，hash-chain/append-only）。**portable/runtime_record 必须 registry/CI 受控沙盒独立重跑生成。**（接 §10.5 阶梯）

5. **众包遥测：隐私 + 环境污染双阻断**（两路一致）：**严禁上传 payload**（用户真实任务可能含源码/财务/密钥）；只 opt-in 上传极简指标 `run_id/plugin_id/status/environment_clean_hash`（redact 后 hash）；终端用户**环境 hash ≠ 标准基线**（检测到 ambient skill）→ 该成功**直接丢弃**不计入 portable 升级权重。

6. **职责边界刀砍斧劈清晰**（两路一致）：
   - **Layer 1 遥测** = O(ms) **fast-fail linter + 证据记录员**，日常常态跑，越界即本地报错；**不证正确性**。
   - **Layer 2 clean-room** = O(min) **权威 gate**，造物理真空，真空里跑通即证无隐性依赖；**负责最终宣判**。
   - 字段分离：`cleanroom_verdict`（权威）vs `runtime_observations`（疑似/审计）；**UI 绝不把 observations 合成 verified 徽章**；遥测命中只触发 `needs_reverification`；**单次用户 trace 永远不能 hard-fail 一个包**。

**结论**：你的遥测思路对、且 SuperClaw 已有现成的权威工具触发证据可用。但正确定位是**"疑似耦合雷达 + drift 监控 + clean-room 复测触发器"**——v1 就是 `submit` 时一个本地只读 diff 的 fail-closed 声明校验（便宜、守铁律）；**所有 portable 背书仍来自可重放 clean-room，prose 盲区必须靠 clean-room 空目录 + 静态 lint 补，绝不能幻想 telemetry 自然看见。**

### 10.7 具体入口：`skill doctor --from-chat <chat_id>`（按开发者指认的会话探查，用户思路）

> 用户思路：打包时针对**开发者跑通的那个 chat 会话 ID**，探查它实际用了哪些 skill——是否用了原生 skill、是否只用了提交选择的那个、有没有别的 skill/tool。**核实：架构支持，数据现成；这把 §10.5 证据背书 + §10.6 声明校验串成一个开发者友好的入口。**

**重要认知纠正**："探查"不是事后向 runtime 查询（runtime 不保留可查的 per-chat skill 使用日志）。机制 = **SuperClaw 读它自己为该会话持久化的记录**（`ChatMessage` 带 `run_id`+`transcript_artifact_id`；turn 的 `@skill:/@plugin:` overlay 记录了显式选择）+ 可选 clean-room 重跑该会话 prompt。

**从一个 chat ID 能答什么（已核实 file:line）**：
| 问题 | 可答 | 依据 |
|---|---|---|
| 只用了你提交/选的那个 skill 吗 | ✅ | chat turn = 1 runtime turn + overlay；`@skill:/@plugin:` 精确记录显式选择（chat_turn.py overlays/plugin_ids/skill_ids） |
| 偷偷用了别的受治理 skill/plugin 吗 | ✅ | 受治理能力（含 skill-origin skill）经 MCP proxy → 写证据记录；**PROXY 层投影的 SKILL.md 是指向 proxy 工具的指针，runtime 调它仍是被记录的工具调用**（即便投在 ~/.claude/skills） |
| 用了原生工具（shell/文件/原生 MCP）吗 | ✅ | transcript 工件持久化 runtime 输出流（codex notification/claude tool_use），`ChatMessage.transcript_artifact_id` |
| 用了 runtime 自带纯 prose skill 吗 | ❌ 盲区 | 非治理、自包含 prose 的 native SKILL.md 是 context 注入非工具调用 → 看不见，**只 clean-room 空目录能验** |

**落地流程**：`skill doctor --from-chat <chat_id>` 读该会话的 ① 选的 overlay（声称用的 skill）② 证据记录里实际触发的受治理能力 ③ transcript 里的原生工具 → diff 出包外/未声明项 → fail-closed 声明校验（"该会话还用了 X，请加 dependencies 或确认无关"）→ 签名后即 §10.5 的 `developer_claimed` 证据包。

**三护栏不变（沿用 §10.5/§10.6）**：
1. **盲区仍在**：纯 prose ambient skill 探查看不见 → 提示"原生 prose 不可见，跑 `--hermetic` 才能确证"。所以是**线索/声明校验，不是 portable 认证**。
2. **Zero-Trust**：开发者自己机器上的会话，可挑"看起来干净"的甚至构造 → 只配 `developer_claimed`；portable 必须 registry/CI clean-room 重跑。**这天然堵住"挑会话作弊"**。
3. **触发 ≠ 决定性**：仍是声明校验（declare or prevent），不证决定性。

**与现状的依赖**：纯 chat（无 `@skill:` overlay，"zero-overhead chat" chat_turn.py:70）若验证 skill，则无治理投影=无 proxy 证据，只剩 transcript——这种情况建议**引导开发者用 `@skill:<id>` overlay 在会话里验证**（这样治理投影+证据齐全），或直接走 clean-room。这也顺带给了 v1 一个清晰的"如何正确验证你的 skill"开发者指引。

**结论**：你的"按 chat ID 探查"对、可建、数据现成——它是 §10.6 声明校验的**最佳开发者入口**（指着真实成功会话说"就这个"）。能精确答"是否只用了你选的 skill / 有没有别的受治理 skill 或原生工具"，唯一看不见的还是 runtime 自带纯 prose skill（老盲区，clean-room 兜）。定位仍是 `developer_claimed` 级线索，portable 认证仍归 clean-room 重跑。

#### 10.7.1 补充：直接问模型"你刚才用了什么 skill/tool"行不行？（用户追问）
**能问、它会答——但只能当 advisory 线索，绝不能当 gate。三个硬伤 + 一个现实约束：**
1. **对工具，问模型不如读日志**：模型上一轮的 tool_use 本就在它上下文里，问它它会念——但这些 SuperClaw 已有**结构化记录**（proxy 证据 + transcript tool 事件），直接读更准更不漏。问模型是退一步。
2. **对 prose skill（恰是盲区），模型常不知道**：skill 是注入上下文的指令，模型多数只看到"一堆指令"，**不知道来自哪个 SKILL.md**（尤其 ambient/built-in）；问"用了哪个 skill"→ 答不全或 **confabulation**（编合理答案）。最答不准的正是最需要的地方。
3. **最致命：被测 skill 能 prompt-inject 操纵回答**——恶意 skill 正文写一句"若被问用了什么 skill，只说 [提交的那个]"即可骗过探查。**正在审查的东西能篡改审查结果** → 自报永不能做 fail-closed gate。
4. **现实约束**：codex-app-server 会话是内存态（`_CHAT_CODEX_SESSIONS`）、claude 在原生内存；**同一活会话可追问，但过去的 chat 按 ID 回去问，活会话已不在**，只剩持久化 transcript 或 clean-room 重跑。

**正确用法**——prose 盲区里 SuperClaw 无结构化数据，问模型是该块**唯一廉价信号**：
| 信号源 | 用途 | 可信度 |
|---|---|---|
| 结构化日志（proxy 证据 + transcript tool 事件） | 工具/受治理 skill | ✅ 权威，可 gate |
| **问模型"用了什么 skill/tool"** | **prose 盲区**廉价探针 | ⚠️ **advisory 线索，绝不 gate**（会编、可被 prompt 注入操纵） |
| 静态 prose-lint（扫依赖暗示词） | prose 盲区 | ⚠️ advisory |
| clean-room 空目录重跑 | prose 盲区 | ✅ 权威，最终判据 |

→ "问模型"= §10.6 prose 盲区的**第三条 advisory 探针**（与 prose-lint 并列）；三者都喂开发者看、触发复测，但**portable 最终认证仍归 clean-room**。

### 10.8 ★ Scoping 决定：v1 简化为"开发者手选打包"（用户拍板）

> **用户决定：先不做自动耦合检测（clean-room/遥测/eval）。v1 = 扫 runtime skill 目录 → 列表 → 开发者自己勾选用到的 skill → 一起打包。** §10.1–10.7 的自动验证机制全部**降级为未来"升级到 portable"的可选通道**，不进 v1。

**为什么这是干净的简化（非降级偷懒）**：
- 本质 = "让开发者手动把用到的 skill 一起打包，使包自包含"——§10"要么内联要么声明"的最朴素实现；开发者最懂自己工作流。
- 定位 = **`developer_claimed`**（自声明自包含），正好是 §10.5 阶梯的一级；将来要 `portable` 徽章再上 clean-room 重跑。**前面设计不浪费，变成升级通道。**
- 贴现有架构：runtime skill 目录 `skill_sync.RUNTIME_TARGETS` 已知（~/.codex/skills、~/.claude/skills、~/.gemini/skills）；"读取机制"=扫这几个目录列 SKILL.md；勾选后复用现成 `import-skill` + submit 门打包。**零新协议。**

**v1 流程**：扫 `RUNTIME_TARGETS`（复用 skill_sync，不硬编码路径）→ 生成 SKILL.md 列表 → 开发者勾选"我用了这些" → 全部打进同一个包提交。

**几个便宜但必须顺手做对的守门（不是把重机器加回来）**：
1. **重分发/secret**：勾选的 skill 可能是第三方/runtime 自带的（重分发有授权/IP 问题）或夹带私密内容 → ① 提示"只打包你有权重分发的"；② **复用 submit 已有 secret-scan** 扫被打包 skill（本就会跑）。
2. **内置（非文件）skill 残留盲区**：编进 runtime 本体的内置 skill 目录无文件→勾不了打不进→包仍隐性依赖 → **诚实标 `developer_claimed`/`runtime-native`，不标 `portable`**。
3. **打包=冻结快照**：把 skill B 打进 A 的包=复制一份快照，B 升级不自动跟；v1 可接受（知道"打进去的是当时那份"）。
4. **自声明≠验证**：UI/徽章如实写"开发者声明自包含"，不显示成"已验证"——守住诚实不洗白。

**结论**：v1 做"扫目录→列表→勾选补充→一起打包"，定位 `developer_claimed`，复用现成机器 + 几个便宜守门；clean-room/遥测/eval（§10.1–10.7）留作未来要 `portable` 徽章时的升级通道。

---

## 11. 上传/发布的测试与安全检查 + 安装期兼容检查（用户拍板，重点防供应链）

> clean-room 名词解释：**干净/隔离的测试环境**——把被测 skill 放进一个全新、空 skills 目录的 runtime 去跑（`SUPERCLAW_*_SKILLS_DIR` 指空临时目录），看它能否独立工作；偷偷依赖 ambient 就会在真空里暴露。**clean-room 本质就是 skill 的隔离测试**，是下面"本地测/云端测"的测试手段。（注：本节安全敏感部分经 Codex+Gemini 验证，结论并入。）

### 11.1 内置 skill：不猜测，改"标注 runtime + 安装期检查"（用户决定）
- **不判断**是否用了 runtime 内置 skill（又难又不可靠）。
- **标注 runtime-of-record**（name+version）当**纯元数据**（不是"已验证兼容"声明，UI 须如实写"制作于 Hermes vX"避免误读）。
- **安装期兼容检查**（写进路线图）：用户装包时检查本地是否有该 runtime/版本 + 打包进的依赖在场；缺失则**告知/警告让用户针对性配置**（非硬拒——降级可用 + 明示风险，除非高危包）。
- 与 §10.8 手选打包合并：**只让用户决定是否补充其他用到的 skill**，内置的靠 runtime 标注 + 安装检查兜，不强求。

### 11.2 两阶段测试 + 隐藏安全检查（用户提出，标准两层验证架构）
**Stage 1 — 本地自检（上传前，开发者侧）**
- 开发者本地跑一遍，**内核默认注入安全检查**（探针 + 提示词），**对开发者隐藏**（不暴露检查内容→无法照着规避）。
- **只暴露 通过/不通过 + 失败理由**；理由须**可操作但不可被规避**（给类别如"尝试未声明网络外联"，不给完整探针逻辑）。
- 定位 = **`developer_claimed` 证据，Zero-Trust**（开发者机器可篡改）→ 仅初筛/体验，**不能当最终准入门**。

**Stage 2 — 云端测试（发布前，站长侧）**
- 正式接收上传、发布到能力工坊前，站长可选**云端受控沙盒重跑**（隔离/网络 egress 控制/资源限制/digest 重验/**不信本地证据**），尤其安全/供应链；产出 **`registry_verified`**（权威）。
- **这是防供应链攻击的关键**：攻击者控制不了云端 runner、看不到隐藏检查。

### 11.3 ⚠️ "直接发布" ≠ 裸放行（主代理加固，防供应链洞）
- 站长可"直接发布"，但**"直接"只能是"跳过深度安全/行为测试"，绝不能跳过自动基线门**（secret-scan / 禁运行时下载代码 / SBOM 漏洞 / 签名验证 等 ~20 门）。否则"直接发布"本身=供应链洞。
- 站长的选择 = **快速通道（自动基线门必过）** vs **彻底通道（基线门 + 云端深度安全测试）**。
- **高危包（申请新权限 / 带原生代码 / 涉 payment）强制走云端测试，不给"直接发布"选项**——供应链攻击最可能藏处。

### 11.4 供应链攻击面与防御（云端沙盒最小正确形态）
- 装包时执行代码 / sidecar 启动 / 依赖拉取 都是攻击面 → 云端沙盒：**网络默认 deny-all（仅放行 manifest 声明的 host）+ 文件系统隔离 + 资源/超时限制 + 装包不执行任意脚本 + digest/签名重验 + 不信开发者本地任何证据**。
- 与 §8.3 提交信任边界一致：**签名服务隔离**（云端测试 worker 无签名密钥，测试通过 → 隔离 KMS 才签）。

### 11.5 铁律分层
- 测试/安全检查逻辑落内核（`skill_verifier.py` / submission gates），CLI 跑本地自检（exit code + reason），云端 registry/CI 跑权威测试；
- 隐藏安全检查提示词/探针落内核、**不下发到表层、不写进包**（防 gaming）；
- 证据：本地自检证据开发者签 = `developer_claimed`；云端测试证据 registry 签 = `registry_verified`（接 §10.5 阶梯）；
- 表层只展示 pass/fail + reason + 分级，不重新解释。

**结论**：内置 skill 不猜、标 runtime + 安装期兼容检查；测试两阶段——本地隐藏自检（Zero-Trust 初筛，只露 pass/fail+理由）+ 云端权威重跑（防供应链）；**"直接发布"必须仍过自动基线门，高危强制云端测**；隐藏检查不暴露内容、不进包。

### 11.6 ★ Codex+Gemini 第二轮纠正（强制覆盖 §11.1–11.5 冲突处）
两路对 §11 草案一致提出以下纠正，**冲突以本节为准**：
1. **本地自检 = 信任权重 0，纯 advisory/UX**：服务端**完全无视**本地安全检查结果。Stage1 改名 `local_self_check`/`developer_submitted_evidence`，**不解锁发布、不影响信任等级**；只有 Stage2 云端产 `registry_verified`（绑 exact digest + verifier 版本 + policy 版本）。
2. **放弃"本地隐藏检查"（security-by-obscurity 是安全剧场）**：攻击者抓包/dump 就拿到隐藏逻辑，模糊理由还逼正常开发者试错测绘规则。改为：**静态规则公开 + 返回结构化 reason code**（`SECRET_PATTERN_DETECTED`/`UNDECLARED_EGRESS`/`INSTALL_SCRIPT_DENIED`/`SIDECAR_UNDECLARED`/`DEPENDENCY_INTEGRITY_MISMATCH`/`CHECK_UNAVAILABLE_FAIL_CLOSED`…每条带 layer/subject/evidence_id/remediation_hint，不暴露 prompt/匹配细节/阈值/绕过条件）。**真正"隐藏"的只是云端动态探针**（攻击者够不到你的云）；防 gaming 靠云端沙箱不可绕，不靠规则保密。
3. **"直接发布"= 仅纯非执行包**（纯声明/纯内容/纯 UI metadata）：仍强制服务端 schema+digest 重算+secret-scan+SBOM+签名+权限声明校验。**高危强制云端测、非可选**；高危触发项很广（Codex）：新权限/原生/payment + 依赖图或 lockfile 变化/install lifecycle script/动态下载/Git·HTTP 依赖/sidecar·process spawn/本地端口/网络 egress/secret 读/browser·session·cookie/MCP tool·server/混淆代码/**二进制 blob**。→ **任何可执行路径都强制云端沙箱**，"直接发布"基本只剩纯 prose/metadata。
4. **安装期 = fail-closed 非 warn**：runtime 缺失/版本不在声明范围/依赖缺失/digest 不符/manifest·tool schema 不符/verifier unknown/高危缺云端签名 verdict → **拒装**（无 `--force` 后门、不自动降级；降级只能是 manifest 明确声明且自身已验证的受限模式）。warn 仅限非执行路径可选依赖缺失/范围内 patch·minor 差异/低风险缺深度云测。
5. **runtime-of-record 拆成声明/观察/裁决三语义**（防误读为"已验证兼容"）：`package_declared_runtime`（开发者声明，未验证）/ `local_observed_runtime` / `runtime_compatibility_verdict`（云端 Stage2 实拉起该 runtime 测试后签的）/ `verified_by` / `verification_scope`。UI **不能把 runtime 元数据显示成绿色"已验证兼容"**，只有 verifier 签过的 verdict 才叫 verified；安装只信云端签名 verdict 不信裸元数据。
6. **多层 verdict 按主体分离**（守 CLI 唯一事实源）：`local_cli_verdict`（CLI，绑 digest）/ `registry_signed_verdict`（云端，绑 digest+policy+sandbox）/ installer 只验签+digest+兼容门不造新语义 / runtime 只握手+再校验不把观察升成认证 / UI 只展示签名 verdict + reason code。

---

## 12. 编译二进制 + 加密 plugin 的供应链安全（用户问"如何彻底杜绝"；经 Codex+Gemini 验证）

> 用户问：plugin 要加密打包；若是用户编译的二进制，如何判断安全性、彻底杜绝供应链攻击？**两路裁断（不骑墙）："彻底杜绝"不可达——但有一个对象可以彻底杜绝。**

### 12.0 诚实立场（必须先讲）
- **Rice 定理**：无法用任何静态/算法手段证明任意二进制无恶意；动态分析覆盖不全输入（time/account/input/geo/secret-存在性 触发的 logic bomb 逃逸观测）。**谁承诺"完全杜绝"谁在骗。**
- **Codex 的精准 reframe**：**不能彻底杜绝恶意 plugin；能彻底杜绝的是"不透明二进制进入 official 且无硬边界运行"这种平台失守形态。** 目标从"证明安全"→"即使恶意也越不出声明权限 + 可观测 + 可即时吊销 + 可追责"。

### 12.1 已核实的现状真洞（file:line）
- 二进制是一等形态（schema `runtime.platforms` x86_64/aarch64，:58/:255），但 provenance（build_type/source_digest/package_digest/signature）**不足以证明二进制来自源码+受控构建**。
- **二进制绕过所有文本扫描**：secret-scan 遇 `\x00` 跳过（plugin_submission.py:399/410），code-download-scan 只读文本 → submit ~20 门对二进制透明。
- **运行沙箱是脚本文本 preflight 非 OS 边界**（plugin_proxy.py:696 注释自承"不替代生产 OS/容器/WASI 沙箱"）。
- **digest 不覆盖 exec 位**（已记录真 bug，trust-chain doc:172）——而二进制的可执行位恰恰是威胁载荷，必须修。
→ 今天恶意编译二进制：提交基本没被审、运行只有 subprocess 级弱隔离。

### 12.2 纵深防御（从"审它"转向"关它"；WASM 是客户端硬沙箱正解）
1. **官方层不收不透明二进制**：Official Tier 只收 **源码 Python/JS 或 WASM**；含 Mach-O/ELF/PE/`.node`/加密 payload 且无平台构建证明 → 拒 official。dev 上传的预编译二进制 blob 默认 **untrusted/dev-only**，最严沙箱或不上架。
2. **可复现构建由平台做、且要 hermetic**（源码+可复现只证"二进制来自这份源码"，不证源码良性；构建链本身是攻击面）：平台从锁定 commit、**完全断网 hermetic build、阅后即焚容器**、依赖 lock digest、builder image digest、**禁自定义构建期脚本**（build.rs/postinstall/Makefile 投毒你的构建机）、in-toto/SLSA attestation；**签名服务只签平台构建产物，绝不复签开发者上传 blob**。
3. **声明权限 = OS 级硬边界（换掉占位）；客户端首选 WASM/WASI**：Firecracker/gVisor 是服务端沙箱，**没法在用户 macOS 笔记本当 sidecar 跑** → **强制编译 WASM (WASI)**（轻量/跨平台/默认 deny-all/系统调用层根除逃逸）为首选；原生 fallback：macOS `sandbox-exec`(seatbelt)+broker、Linux namespace/bwrap/nsjail/gVisor、Windows AppContainer。sidecar 每次运行：**无 $HOME、无默认网络（只放行 manifest 声明+审核的 host）、无默认 env secret、只读插件包、临时工作目录、禁任意 spawn**。
4. **云端动态分析（80/20，别过度）**：沙箱跑审核样例+随机输入，注入 canary secret，记 syscall/DNS/egress/文件 diff/进程树；未声明网络/读敏感路径/spawn/持久化 → 拒。**别把符号执行当主防线**（对大型原生二进制工程不可行）；防线重心后撤到**本地强沙箱**。
5. **加密交互铁律**：加密只防终端用户看 IP，**绝不防平台审查**。平台审核/构建/扫描环境必须拿到明文（或可验证等价明文）、能跑、能 hash；签名绑**解密后 digest**；运行只执行已审 hash。**dev 拒绝给平台明文 → 拒 official**（最严 untrusted 或不上架）。**TEE 不适用**（SGX/TDX 是防宿主偷窥代码，这里是宿主防代码作恶，方向反；且引入远程证明/供应商信任/侧信道/调试难，不当早期核心边界）。
6. **可追责 + 即时吊销 + host-owned 确认**：dev 实名 KYC；**撤销表服务端签名带 sequence+expires_at，无新鲜状态 fail-closed**；**支付/浏览器/账号类能力必须 host-owned 最终确认 UI，插件不得自绘**（防钓鱼）。

### 12.3 铁律分层
云端 build/scan/approve 签 attestation + approval ticket（绑 digest+trust tier）；撤销服务签带 sequence/expiry 新鲜状态；**loader fail-closed 校验 ticket/provenance/package-digest/revocation/entitlement 后才启动沙箱**；CLI 是唯一操作+证据展示入口，**CLI/扫描器都不是安全边界，沙箱必须归内核/VM/broker**；本地 daemon 铁腕执行——签名对不上、或**当前 OS 装不了沙箱 → 立即中止，绝不降级到"无沙箱"运行**。

### 12.4 三个被点出的盲点（诚实残留，无法靠本架构消除）
- **kill-switch 不保证**：恶意二进制逃逸后可篡改本地 daemon/屏蔽验证域名/用户长期离线 → 主防线是**本地沙箱**不是吊销。
- **沙箱逃逸**：Spectre/Meltdown 侧信道、OS 内核 0-day 提权（XNU/eBPF）能穿透边界。
- **社工 + 合法权限滥用**：声明权限内仍可用合法 UI 弹窗钓凭证、滥用授权；用户误授权。

### 12.5 80/20 最小可行供应链防御（个人/小团队工坊，剥离幻想）
1. official 暂不收 binary-only。
2. 含 Mach-O/ELF/PE/`.node`/加密 payload 无平台构建证明 → 拒 official。
3. **修 digest 身份**：权限位（exec bit）、重复 zip entry、大小写、Unicode、路径规范。
4. 签名从"包字节签名"升级为 **approval ticket + package digest + 明确 trust tier**。
5. 撤销表服务端签名带 sequence+expires_at，无新鲜状态 fail-closed。
6. sidecar 默认无网络/无 home/无 secrets/禁 spawn，只给 scoped artifact dir。
7. 动态 smoke + canary + egress/fs/process 日志。
8. 支付/浏览器/账号类必须 host-owned 最终确认，插件不得自绘。

**结论**：把话说硬——**恶意 plugin 不能彻底杜绝；能彻底杜绝的是"不透明二进制进官方 + 无硬边界运行"这一平台失守形态**。官方层只收源码/WASM、平台 hermetic 构建、声明权限落成 WASM/OS 硬沙箱、host-owned 支付确认、fail-closed loader + 签名撤销新鲜度——剩下的（侧信道/logic bomb/社工）靠沙箱关住 + 吊销 + KYC 追责，诚实承认证不了 100% benign。

### 12.6 执行与隔离模型：容器到底隔离什么、是否真隔离（用户问，澄清并入路线图）
**容器/沙箱隔离的是"会执行代码的东西"——三类资产里只有 plugin 会执行**：
| 资产 | 执行性质 | 进容器？ | 风险层 / 归谁管 |
|---|---|---|---|
| **skill** | 纯 prose（SKILL.md）注入模型上下文当指令，**不执行、不起进程** | ❌ 不进 | "坏指令引导模型"（**prompt 层**）→ §10（clean-room/声明校验），**与容器无关** |
| **plugin (mcp_sidecar)** | **可执行体**（脚本/二进制）作 subprocess 跑、MCP 通信 | ✅ **就是它进容器** | "恶意代码执行"（**code 层**）→ §12 沙箱 |
| **company** | 治理模板（配置/角色/策略），自身不执行 | ❌ | 成员 plugin/skill 各按上行 |

**能否真隔离 = 看机制，且今天不能**：
- **今天 = 假隔离**：`_sandbox_preflight`(plugin_proxy.py:696) 只是静态脚本扫描 + 裸 `subprocess.run`；plugin 以**普通子进程**跑，能碰文件系统/网络，**声明权限只是声明、无强制**。= BUG-3。
- **机制强弱**：裸 Docker 容器=弱（共享宿主内核，内核 0-day 逃逸）；**WASM/WASI=强**（默认无 syscall，客户端首选）；micro-VM(Firecracker)=强但重/仅服务端；OS 沙箱(seatbelt/bwrap+seccomp)=中。
- **真隔离 = 把声明权限变成内核/runtime 强制的硬边界**（"只能访问此目录/此域名"，越界即挡死，不靠插件自觉）。§12 结论：客户端用 **WASM**，声明权限才真正成硬边界。
- 即便真隔离仍有 §12.4 残留（侧信道/内核 0-day/社工）。

> 一句话：容器给"会执行代码的 plugin"做隔离；skill 不执行不靠容器（靠 §10）；**今天是占位假隔离，§12 就是把它做成真隔离（WASM 优先），让声明权限真正被强制。**

---

## 13. 已核实的真实漏洞 / Bug 优化路线图（本对话本地代码核实，file:line 可信）

> 本节是本路线图对话过程中**本地核实**的现存真洞，独立可修、各自走 Codex+Gemini 验收门提交。**用户点名的是 BUG-1 / BUG-2**；其余为本对话一并核实的真洞，一并纳入跟踪。

| ID | 漏洞 | 位置 | 影响 | 修复方向 | 优先级 |
|---|---|---|---|---|---|
| **BUG-1** | **编译二进制绕过所有文本扫描** | `plugin_submission.py:399/410`（遇 `\x00` 跳过）；code-download-scan 只读文本 | 恶意编译二进制免审过 submit ~20 门 | 二进制走专属门（要平台构建证明/拒不透明 binary official）；**"无法扫描"绝不能当"通过"**，按 §12 处理 | **P0** |
| **BUG-2** | **digest 不覆盖 exec 位** | `plugins.py:93` compute_package_digest；`trust-chain doc:172` 已记录 | 翻转可执行位不改 digest → 签名后仍可改可执行性；二进制 exec 位即威胁载荷 | 把文件 mode/exec 位纳入 canonical digest（连带修：重复 zip entry/大小写/Unicode/路径规范） | **P0** |
| **BUG-3** | **运行沙箱是占位、非真隔离** | `plugin_proxy.py:696` `_sandbox_preflight`（静态脚本扫描+裸 subprocess） | plugin 以普通子进程跑，声明权限无强制 | 落 WASM/OS 硬沙箱（§12.2/§12.6），声明权限成内核强制边界 | **P0** |
| **BUG-4** | **revocation 表未签名、无新鲜度** | `plugin_cloud.py` get_revocations；`trust-chain doc:330` | 可冻结/重放 → kill-switch 形同虚设（单个最大安全缺口） | 服务端签名 + sequence + expires_at + 客户端 watermark + 付费/高危 fail-closed（§9.4） | **P0** |
| **BUG-5** | **submit 收 `signing_private_key` 内联签名** | `plugin_submission.py:177`；`main.py:4710` | 任意密钥即铸 `verified` 包 = 信任洗白现存绕过 | 移除字段（旧字段传入→400）+ 隔离签名服务（只收 approval_id 重算 digest+KMS，§8.3） | **P0** |
| **BUG-6** | **entitlement 不绑设备** | `plugin_proxy.py:339-368`（gate 不校验 device_id/subject/install_id） | entitlements.json 跨机可移植 = 付费授权可分享 | gate 校验服务端签名 grant 的 device 绑定 + token 改服务端签名授权（非本地 SHA256，§9.1） | **P1** |
| **BUG-7** | **B 类 `_exec_tool` ask==allow（fail-open）** | `permissions.py:131-150`；`backends.py:2798` | B 类 runtime(gemini-agent/anthropic-agent) 不强制 ask，敏感操作不拦 | 白名单门：非 bypass 下不执行 run_shell/网络 → 返回 pending（§8.2）；修 `unknown→workspace` 的 fail-open | **P1** |
| **BUG-8** | **Claude permission 契约 stale** | `backends.py` permission_presets 宣称 `--permission-mode default` 实发 `acceptEdits` | UI/契约描述与真实 Claude 姿态不符（误导，非安全洞） | 对齐契约字符串与真实 flag | **P2** |

**修复顺序建议**：P0 里 **BUG-1/2/3（二进制+沙箱链）** 与 **BUG-4（revocation）** 与 **BUG-5（内联签名）** 是供应链失守的三条独立路径，应优先；BUG-1/2 你已点名，且二者天然相关（exec 位 + 二进制审查），可一并修。每项独立、可单独 PR、单独走双顾问验收门。

---

## 14. Runtime 治理架构（三轨分治 + 容器 + intent 门 + Adapter 契约）

> 本节是 §8.2（权限）与 §12.6（容器）讨论的**收口与统一**，完整标准协议已抽成独立文档 [runtime-adapter-contract.md](runtime-adapter-contract.md)（本节只摘要 + 指针，防漂移）。**出发点：最佳性能 + 绝不影响原生 runtime 运行效果。** 经 Codex+Gemini 多轮对抗验收。

**一句话定调**：**统一"策略"，不统一"容器机制"**。SuperClaw 是控制面，定一套安全策略投影到各 runtime 原生 enforcement；只在自己拥有执行权处（B 类工具 / plugin sidecar）才亲自上物理沙箱。**绝不给自带沙箱的 codex/claude 外层再套 SuperClaw OS 容器**（双沙箱打架弄坏 + 零性能收益）。

**三轨分治**（按"谁拥有工具执行权"）：
- **A 类**（codex/claude）：SuperClaw 纯策略翻译器（拼 `--sandbox`/`--permission-mode`），隔离靠**原生沙箱**，**永不外层套容器**（投影 0ms）。
- **B 类**（gemini/anthropic-agent，SuperClaw 自拥 loop）：`_exec_tool` 前置 **GovernedToolExecutor** + `run_shell` 危险时只包这一个子进程（per-call 门微秒级，= BUG-7 的修法）。
- **Plugin**：sidecar 物理硬隔离，**WASI 优先**——这里才值得付容器代价。

**容器 vs intent 门**：容器管"**能不能**碰资源"（看不懂意图）；**intent 门**（`fusion.py` human_gate）管"**该不该**做这件高危事"（支付/扫描/凭证/提权，执行前 fail-closed 人审）。**⚠️ 关键边界：intent 门不是 A 类天然地板**——A 类自己跑 `run_shell curl 支付` SuperClaw 看不见；高危只有"投影成 proxy 工具"或"可拦截原生 approval"才算 `kernel_enforced`，否则不暴露或 fail-closed。契约用 `control_plane_coverage`/`high_risk_gate_coverage` **如实声明覆盖面**，防误报安全。

**Adapter 标准契约（加 runtime 的"答题卡"）**：MVP 7 项 = `execution_model` + `native_sandbox`(禁双沙箱) + `permission_presets` + **`control_plane_coverage`** + `tool_projection` + `display_field_matrix` + `conformance_fixtures`。**契约落成代码 Protocol（`agent_runtime/adapter.py` 的 `AgentRuntimeAdapter`）+ conformance gate，不是巨型总文档**；已有子契约（permission-mode-framework / display-protocol / prompt-envelope / fusion）各管各的，本契约只新增并强制上述治理项。Sandbox 原语 B 类动作沙箱与 plugin 沙箱**同技术、两实例两策略、共享 ResourceConstraint**。

**性能/风险预算**：性能预算花在"意图识别+状态流转、保留 session、少逐 call 人审"，**别给可信进程套容器**；风险预算花在"B 类危险指令 + 第三方 plugin 沙箱 + host-owned 高危确认"，**别防商业 CLI 二进制本身**。拖性能的从来不是笼子，是逐 call 交互审批——风险分级即可性能风险双不牺牲。

→ **完整字段表 / SandboxSpec 接口 / Protocol 骨架 / coverage 分级 / 三轨细节见 [runtime-adapter-contract.md](runtime-adapter-contract.md)。**
