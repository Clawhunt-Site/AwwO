# 插件信任链硬化设计（Trust Chain Hardening）

Status: 设计要求（在 `plugin-submission-approval-signing.md` 基线之上的硬化补充）

本文是对 [`plugin-submission-approval-signing.md`](./plugin-submission-approval-signing.md)
的补充。基线文档已经定义了服务端「提交 → 审核 → 批准 → 签名 → 发布 → 运行时」的
生命周期，本文不重复，只补齐基线未覆盖、且经过对抗式审查（Codex GPT-5.5 与
Gemini 双模型交叉验证）确认的硬化项：

1. 密钥角色层级（offline root → online key 委托）
2. 客户端防回滚（anti-rollback）与撤销新鲜度（freshness）的 fail-closed 语义
3. 开发者密钥治理（注册、CI/KMS release key、团队多公钥、轮换）
4. 包 digest 规范化的已知盲点（含一个现存代码 bug）
5. 分发模型：票据制（ticket-in-package）vs 全局 catalog 的取舍
6. payswitch 类支付插件的运行时遏制规格（签名之外的防线）

涉及三端：**clawhunt**（云端 marketplace + 身份）、**superclaw**（本地运行时 +
用户端商城）、**插件**（当前 payswitch，支付代理，资金级风险）。

---

## 0. 核心结论（为什么需要本文）

签名链只回答一个问题：「这些字节被谁背书过」。它**回答不了**：

- 攻击者投喂一个「未过期但旧」的 catalog/撤销表，让用户停在有漏洞版本（重放/降级）。
- 一个签名合法的支付插件在运行时偷 token、改金额、绕授权（运行时滥用）。
- 开发者机器被控后用合法流程签出恶意包（构建环境不可信）。

因此「签名链完整 ≠ 插件安全」。本文的所有硬化项都围绕这三类签名覆盖不到的风险。

### 本轮已确定的两个架构决策

- **决策 A（开发者签名角色）**：**分阶段——先降级后纵深**。
  - v1：客户端关键路径**只验商城 online key 签发的票据/registry 元数据**；开发者
    签名仅在服务端上传时校验，作为审核证据与不可抵赖记录，**不进客户端关键路径**。
  - v2：把「客户端独立验开发者签名」作为**纵深防御**加回（防御你自己后台被攻破时
    伪造某开发者的包）。manifest 结构从一开始就保留 `provenance.developer` 字段，
    避免 v2 时返工。
- **决策 B（运行时沙箱）**：**签名链优先，沙箱随后**。先把 §1~§5 的分发/信任链硬化
  做完；§6 的运行时遏制规格本文先写清楚，作为紧随其后的阶段，避免以后返工。

---

## 1. 密钥角色层级：offline root → online key 委托

### 问题（双模型一致指出）

把「客户端内置一个 root 公钥，且这个 root key 直接签 catalog/票据」会产生两个硬伤：

- **签名死锁**：root key 要离线（HSM/冷存）才安全，但 catalog/票据是高频更新的
  （每天上架若干插件）。让冷存 root key 每次发版都出来签一次，运维不可行；为自动化
  把 root key 放上云，又违背了离线初衷。
- **不可轮换**：客户端写死了 root 公钥。一旦 root 私钥泄露或 HSM 损坏，唯一补救是
  强推客户端更新——不更新的用户永久暴露在 RCE 风险下。

> 注：作者此前曾把「完整 TUF 角色分离」整体判为过度设计。修正：**完整 TUF
> （snapshot/timestamp/targets 全套）暂不需要，但 offline-root → online-key 这一层
> 委托是必需的，不是过度设计。**

### 方案：两层密钥 + 角色分离

```
offline root key   （离线 HSM/KMS，极少使用）
    │  只签「角色/密钥集」元数据：声明当前有效的 online key 公钥 + 有效期
    ▼
online 签名 key（们）  （驻服务端，可自动化，可轮换且无需更新客户端）
    ├─ catalog / approval-ticket key   → 签插件审批票据
    ├─ revocation key                  → 签撤销元数据
    └─ timestamp / freshness key       → 签新鲜度声明（防重放）
```

客户端只内置 **offline root 公钥**。验证链：

```
内置 root 公钥
  → 验「角色元数据」（root 签）→ 得到当前有效的 online key 公钥集
  → 验票据 / 撤销 / 新鲜度（online key 签）
```

好处：

- 日常签名全部由 online key 完成，root key 几乎不出场。
- online key 泄露 → root 签一份新角色元数据把旧 online key 作废即可，**无需更新客户端 App**。
- root key 轮换通过「角色元数据 + 一次客户端更新」完成，但频率极低。

不引入 X.509 / 证书链 / RFC3161：用 Ed25519 + 签名的 JSON 角色元数据即可表达同等的
「root 背书 online key」语义。RFC3161 时间戳可不做，但**审批时间必须由商城签发**
（见 §2.3）。

---

## 2. 客户端防回滚与撤销新鲜度（fail-closed）

### 2.1 catalog/票据防回滚：持久化水位线

`expires_at + 版本单调递增` **不够**。攻击者通过 MITM / 篡改本地缓存，投喂一个仍在
有效期内、但序号较旧的 catalog/票据集合，使客户端回退到尚未包含最新撤销的状态。

要求：

- 商城每次发布的 catalog/角色/撤销元数据带一个**单调递增的 `sequence`/`epoch`**，由
  对应 online key 签名。
- 客户端在本地**持久化**「见过的最高 sequence」（写入 `.superclaw/plugins/trust-state.json`）。
- 任何 sequence **低于本地水位**的元数据一律**拒绝**（fail-closed），即使签名有效、未过期。
- 同理插件版本：客户端拒绝安装/降级到低于「该插件已安装版本对应的已批准最高版本」的版本，
  除非用户在开发者模式显式确认。

### 2.2 撤销新鲜度：支付插件强制刷新

签名的撤销表也能被「冻结」：攻击者断网或劫持更新通道，让客户端一直用旧撤销表，使已被
撤销的恶意包继续运行。

要求：

- 撤销/新鲜度元数据带 `expires_at`（短期，如 24h）。
- **普通插件**：撤销表过期 → 警告 + 尽力刷新，可短期宽限。
- **支付插件（commerce 标记或 capability 含支付）**：撤销/新鲜度元数据过期或**无法刷新**
  时，对该插件 **fail-closed**（拒绝执行），不给宽限。宁可不可用，不可用过期信任态执行
  资金操作。

### 2.3 时间不可信

开发者本地签名时间不可信（key 泄露后攻击者可声称恶意包是「泄露前签的」）。客户端只信任：

- 商城 online key 签发的**审批时间**（approval time），以及
- 元数据的 sequence/有效期窗口。

---

## 3. 开发者密钥治理

### 3.1 私钥放哪：纠正「本地 keychain 即 release 机制」

大原则不变：**开发者私钥绝不上 clawhunt 服务端**（否则商城能伪造开发者签名，开发者
签名失去意义；且服务端被攻破全泄露）。

但「私钥放本地 OS keychain 就完事」是错的（双模型一致）：

- CI 容器没有 OS keychain → 逼开发者把私钥导出成明文 CI secret，反而击穿「私钥不外泄」。
- 团队协作 / 离职 / 换机 / 多人维护，个人 keychain 治理不了。
- 开发者机器被控后，恶意进程可调用签名流程签出「合法」的恶意包。
- 签了包不证明构建环境可信：被污染的 CI / 依赖锁照样产出合法签名包。

正确分层：

| 用途 | 存放 | 说明 |
|---|---|---|
| **dev / 身份 key** | 开发者本地 OS keychain | 用于本地提交、标识、开发完整性检查 |
| **正式 release 签名 key** | **CI + KMS/HSM** | 签名前需审批；记录 commit、builder、依赖锁、CI run id |

publisher 必须支持**绑定多个公钥**（active/retired），以适配团队、轮换、换机。

### 3.2 公钥注册（门 1：开发者准入）

- 仅**开发者账户**有签名密钥对；普通消费用户无需（只需内置 root 公钥验票据）。
- 准入批准后，开发者在本地/CI 生成密钥对，**仅公钥**注册绑定到 clawhunt 账户。
- 上传时（即便走 v1 降级路径），服务端校验：上传者是已准入开发者，且 manifest 内声明的
  开发者公钥 == 账户注册的某个 active 公钥。

### 3.3 轮换与撤销粒度

- 私钥丢失 → 注册新公钥；旧版本仍有效（商城票据为旧版本背书了旧公钥）。
- 私钥泄露 → 按 `developer_public_key` 粒度撤销受影响版本 + 作废该公钥。
- 账户接管风险：**密钥变更 / publisher 变更 / 权限扩大必须人工强审**，并在客户端
  对用户提示「发布者密钥已变更」。
- v1 撤销先做**两种最关键粒度**即可：精确 `package_digest` 撤销 + `publisher`/公钥撤销；
  暂不做过早的多粒度组合（YAGNI）。

---

## 4. 包 digest 规范化盲点（含现存代码 bug）

当前 `compute_package_digest()`（`packages/superclaw/src/superclaw/plugins.py`）拼接
「相对路径 + 内容」并跳过 `__pycache__`/`.pyc`。Codex 审查发现它**未覆盖文件权限/可
执行位**——而 payswitch 入口是二进制 `bin/payagent-superclaw-core`，`.scplug` 解包时会
按 zip `external_attr` 恢复权限位。

**真 bug**：攻击者翻转 exec 位、或改入口文件权限，**digest 不变**，签名仍验得过。

规范化必须纳入（或显式拒绝）以下，否则留下重排/改名/歧义空间：

- [ ] 文件**权限 / 可执行位**（当前缺失 → 必修）
- [x] 相对路径 + 内容（已有）
- [x] symlink 拒绝（已有）
- [x] zip 路径穿越拒绝（已有）
- [ ] 目录项、空目录的处理约定
- [ ] 重复 zip entry 拒绝
- [ ] 大小写冲突（大小写不敏感文件系统上的碰撞）拒绝
- [ ] 文件名 Unicode 规范化（NFC）或拒绝非规范名
- [ ] 文件长度纳入（防拼接歧义；当前以 `\0` 分隔，需确认无歧义边界）

服务端与客户端必须用**同一套规范化算法**重算并比对（基线文档已要求服务端不信开发者
声明、上传时重算）。

---

## 5. 分发模型：票据制 vs 全局 catalog

两家分歧、本文取舍：

- Gemini：砍掉全局 catalog（会膨胀到数 MB~数十 MB），改为商城把
  `marketplace_approval.sig`（online key 签）**注入 `.scplug`**，客户端 O(1) 验证。
- Codex：全局 catalog 长期更可扩展，但前提是 **loader 永不接受裸 blob**；短期更稳的是
  客户端只信 marketplace 复签的 release bundle。

**取舍：v1 采用票据制（ticket-in-package）。** 理由：

1. 它天然化解 §1 的签名死锁——每次审批只用 online key 签一张**小票据**，无需每次发版
   重签全局 catalog。
2. O(1) 验证，无 catalog 膨胀。
3. 与决策 A（v1 降级开发者签名）契合：客户端关键路径就是「验票据」。

票据（approval ticket）最小字段，由 online (catalog/approval) key 签名：

```json
{
  "plugin_id": "dev.clawhunt.pay-switch-agent",
  "version": "0.2.0",
  "package_digest": "sha256:...",
  "developer_public_key": "ed25519:...",
  "publisher_id": "dev_abc123",
  "granted_acceptance_level": "L2",
  "allowed_audience": "private_beta",
  "approval_time": "2026-06-08T12:00:00Z",
  "sequence": 12345,
  "expires_at": "2026-07-08T12:00:00Z"
}
```

**硬约束（Codex）**：客户端 loader 的**所有入口**都必须走完整 proof，**永不接受裸
blob**。要堵死的绕过点：

- 「按 blob digest 直接安装」
- 「本地导入缓存 / 旁路 install」
- fake-cloud registry / dev path（仅开发者模式，且明确标注「未验证」）

完整验证链（安装 + **每次加载**）：

```
角色元数据(root签) → online key 集
  → ticket(online key 签) → 校验 sequence ≥ 本地水位、未过期
  → package_digest 比对（重算下载/缓存字节）
  → [v2] developer signature（用 ticket 内公钥验，纵深防御）
  → revocation（签名 + 新鲜度，支付插件 fail-closed）
  → entitlement（见 §6.2）
  → runtime policy / sandbox（见 §6）
```

内容寻址 blob（`/blobs/sha256-xxx`，CDN）保留：artifact 不可变、CDN 友好、篡改即地址变。
但 blob 只负责「按 digest 取字节」，**是否允许分发由 ticket 决定**。

### 加载期 TOCTOU 与缓存被改

安装时验一次不够：缓存目录文件可能被本机恶意进程在「验证通过后、执行前」替换。

- 短期：保持「每次加载前重算完整树 hash」（现有逻辑，安全但较慢；按进程缓存
  digest/签名、撤销每次必查）。修复 §4 的权限位盲点后该校验才完整。
- 中期：从**只读 archive 直接加载**（如 Python `zipimport` / 只读挂载 `.scplug`），
  只验一次包 hash，消除解包散文件被篡改的 TOCTOU 窗口；或安装到**不可变 digest 目录**
  并收紧权限。

---

## 6. payswitch 运行时遏制规格（决策 B：随签名链之后）

签名完全覆盖不了运行时权限滥用。对支付插件这是**头号风险**（双模型一致）。本节先写规格，
作为签名链硬化之后的紧接阶段实施。

### 6.1 进程隔离与能力最小化

- **网络 allowlist**：插件只能连 manifest 声明且经审核的域名（payswitch:
  `clawhunt.store`、其 PayAgent 后端、本地 Chrome relay）。运行时**强制拦截**，
  通过 OS 级沙箱（macOS `sandbox-exec`、Linux `bwrap`/网络命名空间，或容器/gVisor）
  实现，禁止外连任意域名。
- **文件系统隔离**：插件进程**不得读取** `.superclaw/clawhunt-auth.json` 等宿主凭证。
  仅允许其声明的 `plugin_cache` / `artifact_dir`。
- **凭证最小化**：宿主通过环境变量 / MCP 协议**单向**注入短期、scoped 的 PayAgent
  token（payswitch 已有 `clawhunt_account_bridge` 雏形），插件拿不到长期主凭证。
- **MCP capability 隔离**：插件不能借其他插件/tool 横向移动；调用链携带 caller
  identity，便于审计与最小授权。

### 6.2 entitlement 不可绕过

本地 `entitlements.json` 必须是**服务端签名**的，且绑定：
`account_id + plugin_id + package_digest + capabilities + expiry`，并建议绑定**安装 ID /
设备指纹**以防凭证复制。

- 防改系统时钟：离线宽限要锚定服务端 `synced_at` + 最大宽限上限（现有逻辑已有雏形），
  支付类 entitlement 过期 / 未知一律 **fail-closed**。
- 每次敏感调用都查 entitlement/capability，**不只安装时查**。

### 6.3 宿主拥有的支付确认（关键）

- **最终支付确认 UI 由 SuperClaw 原生界面渲染**：金额、币种、商户、收款方、发起插件
  身份（digest/publisher）由宿主展示并要求用户确认。**插件不得自绘最终确认界面**
  （防钓鱼 / 金额掉包）。
- **服务端核验支付结果**：插件返回的「成功」**不是** truth source；最终状态以服务端
  /支付网关核验为准。

### 6.4 审计日志

记录 intent、金额、用户确认、插件 digest、调用时间、浏览器 profile 等，用于事后追溯；
但**严禁记录支付凭证 / token 明文**。

---

## 7. 数据存放总览

### 服务端（clawhunt）

| 数据 | 说明 |
|---|---|
| 开发者注册表 | account → 多公钥（active/retired）、状态、准入时间 |
| 角色/密钥集元数据 | offline root 签，声明当前有效 online key |
| 审批票据 | online key 签，每个批准版本一张（随包下发） |
| blob 仓库 | 内容寻址 `/blobs/sha256-xxx`，CDN |
| 签名撤销表 + 新鲜度 | online key 签，带 sequence + expires_at |
| 审核/审批记录 | 绑 `package_digest`（基线文档已定义） |
| 隔离签名服务 | KMS/HSM，上传/审核进程无私钥访问（基线文档已定义） |

### 客户端（superclaw）

| 数据 | 路径 | 状态 |
|---|---|---|
| 账户令牌 | `.superclaw/clawhunt-auth.json` | 已有；插件进程**不可读**（§6.1） |
| 已验证插件缓存 | `.superclaw/plugins/cache/{id}/{version}/` | 已有 |
| **信任状态/水位线** | `.superclaw/plugins/trust-state.json` | 🆕 §2.1 |
| 角色元数据 + online key 缓存 | `.superclaw/plugins/roles.json`(+sig) | 🆕 §1 |
| 签名撤销表 | `.superclaw/plugins/revocations.json`(+sig) | ⚠️ 已有但**未签名**，须加签名 + 新鲜度 |
| entitlement | `.superclaw/plugins/entitlements.json` | 已有；须服务端签名 + digest 绑定（§6.2）|
| 内置 root 公钥 | `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY` | 已有；语义改为「root（只验角色元数据）」|
| 开发者私钥（仅开发者机） | OS keychain（dev key）/ CI+KMS（release key） | 🆕 §3.1 |

---

## 8. 分阶段 Roadmap（与基线文档 Phase 对齐）

> 基线 `plugin-submission-approval-signing.md` 已规划服务端 Phase 1~8。本表为本文硬化项
> 的落地顺序，按 ROI 排序，**签名链优先、运行时沙箱随后**（决策 B）。

**P0 — 立即修（低成本、真漏洞）**
1. 修 §4 digest 权限/可执行位盲点 + 重复 entry/大小写/Unicode 规范化（`plugins.py`）。
2. 撤销表加签名 + sequence + expires_at；客户端落地 §2.1 水位线 + §2.2 支付 fail-closed。

**P1 — 信任链硬化（决策 A v1：降级开发者签名）**
3. §1 角色元数据：offline root 签 online key；客户端验「root → online key → ticket」。
4. §5 票据制分发：online key 签 approval ticket 随包下发；loader 统一入口、永不接受裸 blob。
5. §3.2 开发者公钥注册；上传侧校验「manifest 公钥 == 账户注册公钥」。

**P2 — 密钥治理与发布安全**
6. §3.1 release key 迁移到 CI+KMS/HSM，dev key 仅本地身份；publisher 支持多公钥。
7. §3.3 密钥/发布者变更人工强审 + 客户端「发布者密钥变更」提示。

**P3 — 运行时遏制（决策 B；payswitch 优先）**
8. §6.1 进程网络 allowlist + fs 隔离 + scoped token + MCP capability 隔离。
9. §6.2 entitlement 服务端签名 + digest/设备绑定 + 每次调用校验。
10. §6.3 宿主拥有的支付确认 UI + 服务端支付结果核验；§6.4 审计日志。

**P4 — 纵深与演进（决策 A v2）**
11. 客户端把「验开发者签名」作为纵深防御加回关键路径。
12. 加载期从只读 archive 加载（§5），消除 TOCTOU；视规模决定是否从票据制演进到
    TUF 式 catalog（targets/snapshot/timestamp）。

---

## 9. 与现有代码的映射

| 现状 | 文件 | 硬化动作 |
|---|---|---|
| `compute_package_digest` 未覆盖权限位 | `packages/superclaw/src/superclaw/plugins.py` | **修 §4 真 bug** |
| `_check_revocation` 读明文 revocations.json | 同上 | 加签名 + sequence + 新鲜度（§2） |
| 单 root key 验 `provenance.signature` | 同上 `_verify_signature_with_trust` | 改为「root → online key → ticket」（§1, §5）|
| `_verify_cached_package_before_execution` 每次重验 | `plugin_proxy.py` | 修 digest 后校验才完整；中期改只读 archive 加载 |
| `_resolve_entitlement` 读本地 entitlements.json | `plugin_proxy.py` | 改服务端签名 + digest/设备绑定（§6.2）|
| fake-cloud registry（未签名） | `plugin_cloud.py` | 替换为票据制分发；dev path 标「未验证」（§5）|
| `clawhunt_account_bridge` scoped token | `plugin_proxy.py` | 扩展为 §6.1 凭证最小化的基础 |

---

## 附:审查来源

本文的硬化项由两个独立模型对抗式审查交叉验证得出（高置信度 = 两家一致）：
- catalog 防回滚需持久化水位线、撤销新鲜度 fail-closed、root/online key 角色分离、
  keychain 不能当 release 机制、entitlement 服务端签名 + 绑定、运行时沙箱为支付头号盲区、
  加载期 TOCTOU、digest 权限位盲点——以上均为两家或 Codex/Gemini 明确指出。
