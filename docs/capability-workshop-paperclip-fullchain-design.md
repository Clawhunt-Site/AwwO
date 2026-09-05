# 能力工坊全链设计 — plugin / skill / company（上传 + 下载，落地归 Paperclip 原生）

> 分支 `feat/workshop-plugin-company-fullchain`（基于 `dev/server-refactor`）。
> 架构裁决经 Codex(gpt-5.5) + agy(Gemini 3.1 Pro) 四轮对抗评审收敛（2026-06-28）。
> 关联铁律：[[upstream-backend-adoption-posture]]（只增不删/不改上游源码）、[[paperclip-as-base-not-our-governance]]、[[server-refactor-to-node-chat-compat]]。

## 1. 一句话架构（H）
能力工坊「下载即导入」：**验权留 Python**（cosign + 自定义域 digest + 吊销 + skill-origin 红线 + 从 R2 取字节，零改写、不 Node 重做 cosign），**落地 / 列表 / chat 使用复用 Paperclip 原生 import**。三类（plugin/skill/company）全链（上传 + 下载）统一此模式。R2 只服务工坊字节分发，与 Paperclip 无关。official 徽章只来自 Python 验过的 cosign（经新增 provenance 侧表持久化）。

**不改 Paperclip 任何核心函数**（`installPlugin` / `importBundle` / global skill loader 零改）；所有接入为 add-only（1 受信导入路由 + 1 provenance 侧表）+ super 侧胶水。

## 2. 三类的 Paperclip 原生导入入口（实测 @ a8318f68）
| 类 | 原生入口 | 落点 | 生效 | 列表权威 |
|---|---|---|---|---|
| plugin | `installPlugin({localPath})`（routes/plugins.ts:1035 / loader:1143） | 仓库外目录（Paperclip 经 packagePath 引用） | registry+lifecycle ready → tool-dispatcher → chat | DB `plugins` 表 |
| skill | 写全局 skill 存 `~/.superclaw/skills/<slug>/`（global-runtime-skills.ts） | 全局 skill 存 | 下一 run / 列表刷新（`listGlobalRuntimeSkillEntries` 可调，catalog mtime 失效） | 全局扫描 union |
| company | `POST /api/companies/import` → `importBundle`（companies.ts:196 / company-portability.ts:4276） | 实例化新 company（companies 表） | import 同步完成即可用 | companies 表 |

**关键**：plugin 装**仓库外**目录 → `ensureLocalPluginBuilt` 三道闸全免（`isRepoBundledPluginPath` false / `PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1` / 已预构建，plugin-loader.ts:798-819）→ 不 build、不碰目录、零改 installPlugin。company import 默认**同步**返回 companyId（不带 `x-paperclip-cloud-async-import` 头）。

## 3. 下载/落地全链（download = import）
公共前半（三类同）：
```
feed 取条目 → Python 验官方共签 + 域digest绑定 + 吊销 + skill红线   ★fail-closed
  → 从 R2 取字节到 mkdtemp → 算 transport sha256(归档字节)
  → 原子落到 super 拥有的不可变目录 <root>/<kind>/<id>/<digest>/ (写.tmp→rename→只读, 禁symlink)
  → 签 receipt-HMAC{kind,id,version,域digest,transport_sha,install_dir,appenv,artifact_ref,TTL}
  → loopback 调 POST /api/internal/workshop-import   (Paperclip add-only 受信路由)
```
受信路由后半（按 kind 分流到原生 import）：
- **plugin** → `installPlugin({localPath: install_dir})`（免 build）→ registry/lifecycle。
- **skill** → 把 install_dir 的 SKILL.md + .provenance.json **原子写**进全局 skill 存 → `listGlobalRuntimeSkillEntries` 刷新 → 下一 run 生效。
- **company** → 把验过的 bundle 以 `{type:"inline", files}` 喂 `importBundle`，`target:{mode:"new_company"}` + `collisionStrategy:"rename"` → 实例化。
公共后半：验 receipt-HMAC + 重算 transport sha == receipt → 写 `workshop_provenance`（绑 native id + digest + artifact_ref）→ 失败回滚（删 install_dir / skill 目录 / company 实体 + 作废 receipt + 不写 provenance）。

## 4. 上传全链（源从 Paperclip 位置逻辑取——它最知道自己东西在哪）
上传端点入参 = **Paperclip 标识 + kind**（pluginKey / skill slug / companyId），Python 经 loopback 问 Paperclip 解析源：
| 类 | Paperclip 源 | Python 处理 |
|---|---|---|
| plugin | 按 pluginKey 拿 `packagePath`（registry）→ 读目录 | plugin review → 隔离签名 → 发布 R2 |
| skill | 按 slug 解析全局 skill 目录 → 读 SKILL.md+载荷 | `_review_skill` → 签名 → 发布 R2 |
| company | 按 companyId 调 Paperclip `exportBundle`（schemaVersion=5 bundle） | `_review_company`（模板契约+域digest）→ 签名 → 发布 R2 |
之后走现役 review/sign/publish_capability_distribution → R2。company 复用 Paperclip 现成 export，不另写。

## 5. 接缝解（全 add-only）
| 接缝 | 解 |
|---|---|
| 列表权威 | super status/列表读 Paperclip 权威源（plugin→DB / skill→全局扫描 / company→companies 表）+ join `workshop_provenance`；保 `PluginStatusPayload` 外形 |
| digest 信任 | receipt-HMAC（loopback 内部密钥）+ transport sha256(归档字节，非解包目录树) + install_dir OS 锁死；Paperclip 导入前重算比对 |
| build/落地 | plugin 仓库外免 build；skill 写全局存原子 rename；company 走现成 import inline——三类零改 Paperclip 核心 |
| 溯源 | `workshop_provenance` 侧表{kind, native_id, digest, artifact_ref, origin, official, receipt_id}；**所有读列表处必 join** |
| 卸载/清理 | super 侧 GC：对比 Paperclip 各权威源清孤儿 install_dir / skill 目录；company 卸载=Paperclip 删实体 |

## 6. 安全不变量（fail-closed，每刀必核）
1. 验不过（cosign/域digest/吊销/skill红线）→ 不签 receipt、不进导入。
2. install_dir 含 digest、不可变、写.tmp→原子rename→只读、禁 symlink、per-key 锁（防 TOCTOU）。
3. receipt-HMAC + 短 TTL + 绑 kind/id/version/digest/install_dir/appenv，防伪造/重放。
4. Paperclip 导入前重算 transport sha256 == receipt。
5. official 仅来自 `workshop_provenance.official`（源自 cosign），绑 native id+digest+artifact_ref（防 rename/重装漂移错贴）；所有读列表处 join。
6. company import 默认 `new_company` + `collisionStrategy:rename`，**禁默认 existing_company**（避免覆盖用户资产）。
7. 完成判据：对应权威源可见 + 真可用；失败回滚。
8. **残留风险（本设计不消除，留痕）**：Paperclip plugin 无沙箱 → official plugin 仍是无沙箱代码执行，Python 验权门是唯一墙；skill 在用户可写目录 → official 徽章只保证「来源真」不防本地改（桌面场景，不做服务端式运行时强校验）。
9. 前提：本机 `aws` CLI + R2 凭证（`~/.config/superclaw/cloudflare-r2.env`），缺则 install-workshop fail-closed 503。

## 7. MVP 边界（首版做什么 / 不做什么，双顾问收敛）
**做**：plugin 外部预构建 localPath install；company R2 verified inline files → new_company import；skill 原子写全局存 + 刷新。
**不做（留后续）**：github 直导（force-push TOCTOU + clone 非确定性断徽章链）、existing-company 更新、复杂 GC、upgrade（本轮升级=卸载+重装）。

## 8. 执行政策 / 切片（每刀=模块+相关测试+Codex单顾问+本地原子提交不推；推 PR 时 Codex+Gemini 满血重门）
| 刀 | 内容 |
|---|---|
| **S1** | Python：Trust Receipt(HMAC) + 不可变 per-digest install_dir 落地 helper（`capability_receipt.py`，三类共用地基）+ 单测 |
| **S2** | Paperclip add-only：`POST /api/internal/workshop-import`（按 kind 路由）+ `workshop_provenance` 侧表(新 schema 文件) + 挂载 + vitest |
| **S3** | plugin 全链：install-workshop 改造（验权后不落 cache→receipt+调 Paperclip）+ 上传按 pluginKey 取源 + super 列表读 DB+join + GC |
| **S4** | skill 全链：工坊安装（验权→原子写全局存→刷新）+ 上传按 slug 取源 + 列表/生效 join |
| **S5** | company 全链：上传 exportBundle→review/sign→R2；下载验权+R2 取 bundle→inline new_company import；列表 join |
| **S6** | 三类端到端 E2E + 安全负例（篡改/吊销/无R2 fail-closed 各一套） |

## 9. 首版验收标准
三类安装后：① 在 Paperclip 权威列表出现；② official 徽章来自 provenance（验过的 cosign）；③ chat/runtime 真能消费；④ 卸载/吊销后不再显示 official。
