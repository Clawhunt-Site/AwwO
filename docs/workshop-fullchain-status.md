# 能力工坊全链(plugin / skill / company)落地状态

> 分支:`feat/workshop-plugin-company-fullchain`(基于 `dev/server-refactor` 集成主干)
> 架构基准:`docs/capability-workshop-paperclip-fullchain-design.md` +
> `docs/capability-workshop-dual-plugin-runtime-design.md`
> 原则:**H 架构 / add-only(只增不删、不改上游源码、必要才碰)/ 复用 Paperclip 原生 import**。
> 验权留 Python(cosign + R2 + receipt 签发),**落地/导入/运行时归 Node**。

本文件记录工坊三类能力(plugin / skill / company)端到端链路在 Node(vendored Paperclip)
后端上的落地进度:**哪些已完成、哪些待办**。

---

## 一、整体链路与闭合状态

```
上传(既有,非本会话新建)
  Python capability_submission.py(plugin/skill/company)
  + Node 公司 export 端点 POST /api/companies/:id/export(portability.exportBundle)
  + capability_r2.publish_local_capability_cloud_to_r2(publish-r2)
  + cosign 签名
      │
      ▼  review / 官方背书 / R2 对象
下载 + 导入(✅ 本会话完成:P1–P7 + S4 + S5)
  receipt 验签(HMAC,Python↔Node 字节级一致)
  → transport_sha256 为唯一完整性边界(buffer-bound 提取,闭 same-UID TOCTOU)
  → 三类 installer(plugin / skill / company)
      │
      ▼
运行时(✅ 本会话完成:P4 双格式)
  通用 JS plugin(fork worker) + super 二进制/脚本/MCP(subprocess MCP via stdio)
      │
      ▼
统一只读 catalog + 卸载(✅)
```

**结论:三类能力的「下载 → 导入 → 列表 → (plugin)执行 → 卸载」端到端全部打通,
并有 S6 三类同会话共存 E2E 守护。上传侧此前已存在。工坊全链闭合。**

---

## 二、已完成(本会话,每片经 Codex/Gemini 对抗验收后原子提交)

| 切片 | commit | 内容 |
|---|---|---|
| 设计 | `118e0ea1` | plugin/skill/company 全链落地设计基准(H 架构 / add-only / 复用原生 import) |
| **S1** | `c4088a8f` | 信任 receipt(HMAC)+ 不可变 archive staging |
| **S2a** | `59bc5628` | Node receipt 验签(与 Python HMAC 字节级一致) |
| **S2b** | `20aacf12` | `workshop_provenance` 侧表 + verified-only store |
| **S2c** | `aec7b3f8` | receipt-gated 导入编排内核(installers 注册点) |
| 设计 | `24553a84` | Node 双格式 plugin 运行时设计(通用 JS + super 二进制/脚本/MCP) |
| **P1** | `911f7898` | `superclaw-plugin.json` manifest 解析 + 校验 |
| **P2** | `ec08f3c1` | `super_plugin_runtimes` 表 + runtime store(物理隔离两类 plugin) |
| **P3** | `42934c41` | super-plugin 执行治理 preflight(no-sandbox RCE 治理门) |
| **P4** | `2b44d2aa` | super-plugin MCP runner + 硬化 stdio transport(双格式运行时核心) |
| **P5** | `f956df64` | 双 runtime router + 统一只读 catalog(official 只来自 provenance + digest) |
| **P6a** | `88ddb7e7` | super-plugin installer 接 S2c(insert-first 原子 claim;teardown DIR-BEFORE-ROW) |
| **P6b-1** | `7a81ebc6` | 硬化 `.scplug` 提取器 + fs 原语(buffer-bound 完整性;独立 CD 校验) |
| **P6b-2** | `e6490b24` | super-workshop Express 路由 add-only 接线(loopback import + catalog + execute + uninstall) |
| **P7** | `7c39d270` | 真子进程 MCP E2E + 进程组拆除硬化(killpg completeness;poll-group-empty) |
| **P7** | `4ce826a8` | plugin-kind 导入链真 fs E2E |
| **S4** | `5369c004` | skill 全链(导入 → 全局 store → kernel 可见 → 卸载;official 绑 DB store_digest 防伪造) |
| **S5** | `db5bea9c` | company 全链(verified bundle → 原生 importBundle → 新公司;失败语义与原生零偏差) |
| **S6** | `08fc878d` | 三类同会话共存 E2E(各落自己 catalog、official、互不串扰) |

**验证:** 162 个 super/workshop vitest 全绿,`tsc --noEmit` 干净(已构建 `@paperclipai/plugin-sdk`)。

### 关键不变量(已实现并被测试守护)

- **完整性边界 = `transport_sha256`**:把整段 archive 读进不可变 buffer,在**同一 buffer**上
  hash + 独立遍历 central directory + 解压 → 关闭 same-UID TOCTOU;独立 CD 校验关闭伪造
  entry-count / cdSize(yauzl@3.x 不验 CRC,故 transport_sha256 是边界)。
- **official 徽章防伪造**:skill 的 official 绑**服务端控制的 DB `store_digest`**(GET 时实时重算
  与 DB 比对),而非可写、被排除出 digest 的 `.provenance.json`。
- **双 plugin 运行时物理隔离**:super plugin 走 `super_plugin_runtimes` 表 + 独立 store,与通用 JS
  plugin 互不串扰;统一只读 catalog 分流。
- **company 失败语义零偏差**:复用原生 `importBundle`,**不做** before/after 全局 company-id diff
  补偿(并发下会误删他人刚建的公司 → 数据丢失);失败时与原生一样留可恢复 orphan;rollback 只删
  **已知精确 companyId**,并发安全。
- **进程组拆除完整性**:detached spawn + SIGTERM → grace → 无条件 SIGKILL 进程组 + 轮询
  `kill(-pgid,0)` 直至 ESRCH;`killGroup` 只用负 pid(不回退正 pid,避免 pid 复用误杀)。
- **错误分类 fail-closed**:显式错误类 → 400;fs-errno allowlist(ENOSPC/EACCES/…)→ 500;
  zlib `Z_DATA_ERROR` → 400。

---

## 三、上传侧(此前已存在,非本会话新建)

工坊**上传/发布**链路 plugin/skill 此前已具备;**company 上传经本会话补齐为 portability 桥**:

- **`packages/superclaw/src/superclaw/capability_submission.py`** — plugin / skill / company
  三类提交。company 现有**两条路径**:legacy `company_template`(`superclaw-company.json`,保留)
  与**新 portability 路径**(COMPANY.md,与导入侧一致)。
- **Node `POST /api/companies/:id/export`** — `exportBundle`,把 live Paperclip 公司导出为
  CompanyPortability bundle(COMPANY.md)。
- **`capability_r2.publish_local_capability_cloud_to_r2`** — `publish-r2`,把本地能力发布到 R2。
- **cosign** 签名 + 官方背书(super 本地独立验签)。

> **更正一处早先误判**:legacy `superclaw-company.json` 与导入侧的 COMPANY.md portability bundle
> **格式不同、不能 round-trip**——"export→submit 两步即可"是错的。已由 company-upload bridge
> (见 §六)修复:新 portability 上传路径产出/审查的格式与 S5 导入侧一致,真正端到端 round-trip。

---

## 四、未完成 / 待办(backlog)

按优先级与归属域列出。**均不阻塞当前全链闭合**。

### 4.1 company-upload portability bridge — ✅ 已完成(见 §六)
原列为 backlog 的「company 一步从 live Paperclip 导出上传」已在本会话实现(slices 1-3),并修复了
legacy 模板与导入侧的格式不连贯。**剩余 backlog**:① cosign 签名的完整官方发布端到端(cosign 未
安装,留 backlog;真 R2 字节通道已冒烟通过)② 真 Node loopback 的 `--from-company` 活体集成冒烟
(需活的 Node 服务,单测已 mock 覆盖)。

### 4.2 推 PR 前的交付门(流程,非代码)
- **同步主仓库最新代码**:发 PR 前按全局/项目铁律,把最新 `dev/server-refactor`(乃至最终目标
  `origin/main`)吸收进本分支并解冲突(尤其前端)。— **本轮正在执行。**
- **本地全量门**:推 PR 前在隔离 worktree 跑通完整 `ci.yml`(`scripts/run-ci-tests.sh` 两阶段 +
  `ruff` + web 测试 + build)。远端 CI 暂停期,本地全量是唯一裁判门。
- **PR 与合并**:从 feature 分支发 PR;绝不 force-push 覆盖他人;合并后本地验证合入树。

### 4.3 后续增强(设计已留,未实现)
- super plugin 配置协议编辑面(`plugin-configuration-protocol-requirements.md`)。
- workshop-import 路由的更细审计/遥测(永不离机约束下)。
- 桌面表层对 super-workshop 路由的转发对齐(若需)。

---

## 五、隔离与纪律状态

- 全部工作在隔离 worktree `feat/workshop-plugin-company-fullchain`(基于 `dev/server-refactor`),
  **未触碰共享主检出、未触碰 dev/server-refactor 检出的他人前端 WIP**。
- 全部**本地提交,未推**(符合 `dev/server-refactor` 开发期纯本地循环纪律:推/合 main 时再走满血门)。
- 每个切片经 Codex(gpt-5.5)/Gemini 对抗验收通过后才原子提交;commit 无 AI 署名行。

---

## 六、company-upload portability bridge(本会话补齐;Codex 裁决的 4 片切分)

**动机**:company 链路上传/审查侧只认 legacy `superclaw-company.json`(`CompanyTemplate`),而下载/
导入侧(S5)只认 `COMPANY.md`(Paperclip CompanyPortability bundle)——**两者格式不同、不能
round-trip**。按业主「上传也按 Paperclip 取项目逻辑」+ Codex 裁决,新建一条基于 Paperclip 导出的
portability 上传路径,与导入侧对齐。**架构收窄**:Python 不重写 portability parser,可导入性交由
Node `previewImport`;Python 只管 CLI/发布身份/digest/R2/receipt。add-only,legacy 路径保留。

| 切片 | 内容 | 验收 |
|---|---|---|
| **Slice 1** | `company_portability_review.py`:portability bundle 本地 fail-closed 审查门(symlink 预扫描短路 / 必填发布身份 slug+semver / 恰一个 COMPANY.md / 文件数+字节上限短路 / 流式全文本 secret scan / 注入式 Node previewImport 严格 schema / 长度前缀稳定 digest) | 49 单测;Codex 三轮 → no blocking |
| **Slice 2** | `company_portability_loopback.py`(强制 loopback 的 export/freeze/preview_fn)+ `submit_company_portability_upload`(复制前 symlink+上限预检;修 `_store_capability_blob` raw-symlink 死检查)+ CLI `capability submit-company --from-company\|--bundle` | 113 单测;Codex 两轮 → no blocking |
| **Slice 3** | 确认 portability 提交走通既有 kind-generic distribution→publish→R2(零并行实现);**真账号 R2 字节 round-trip 冒烟 PASS** | 106 单测 + 真 R2 round-trip |
| **Slice 4** | 文档更新(本节)+ 更正早先「两步即可」误判 | — |

**关键不变量**:完整性边界 = portability digest(长度前缀,杜绝跨树碰撞);loopback **强制本机**
(非 loopback URL 在发请求前即拒,company 字节绝不离机);审查门全部 fail-closed 且短路(symlink/
超限早于任何读取与 Node 调用);发布身份显式(slug allowlist + semver,绝不从 live companyId 推断);
复用 Paperclip 原生 `previewImport`/`importBundle`,绝不并行实现。

**已知取舍 / backlog**:① **cosign 未安装** → 完整官方发布的签名段未跑(真 R2 字节通道已冒烟);
② `--from-company` 的真 Node 活体集成冒烟需活的 Node 服务(单测已 mock 覆盖,生产路径靠
local_trusted loopback=board 授权);③ registry `instantiable=False`(company)是 D3/G1/G2 有意的
verify-before-instantiate 设计(catalog 解析时从 TrustState 派生),**非 bug,不改**。

---

## 七、安装表层接入(后续会话:密钥隔离 + CLI/API 安装/分发表层)

承接 §一~§六(Node S4 导入引擎已就绪),本节记录把「下载→Node S4 落地」**接到表层**的进度。
每片经 Codex(gpt-5.5)**单顾问**对抗验收(业主本轮指定 Codex-only,agy 不参与)后原子提交。

| 切片 | commit | 内容 | Codex |
|---|---|---|---|
| **2a** | `3203a526` | 工坊收据 HMAC 密钥**纯文件传输 + 严格隔离**(key 值绝不进任何 process.env;Python 供 0600 文件+只传路径;Node 从文件读、启动期 scrub 路径先于一切 spawn;为此把 server-info git exec 改 lazy) | 9 轮 → PASS |
| **2b-1** | `a4151fd3` | CLI `capabilities workshop install <id> <ver> [--kind]`(内核/CLI 基线,调 `install_published_capability` 桥 → Node S4) | PASS(抓 envelope 契约 bug) |
| **2b-2** | `efcfdbd9` | 中性 `POST /api/capabilities/install`(API 镜像 CLI,同一桥;校验→422,桥 fail-closed→502 通用 detail+服务端日志) | PASS(抓 502 泄露) |
| **2d** | `a87f17ec` | 中性 `GET /api/capabilities/distribution`(全三类 plugin/skill/company;kind=签名 raw kind 绝不重标、漂移条目丢弃;kind↔R2 前缀绑定;ghost/cosign fail-closed;注册在 `/{capability_id}` 前防 404) | PASS(抓漂移假阳性 + 路由 404) |

**结论:后端(内核 CLI + API)的「下载已发布能力(三类)→ Node S4 落地」install + distribution 两个表层已完整、零偏差、fail-closed、Codex 验收。经 Node 安装现可由 CLI/API 完成(Node 协同在位时)。**

### 7.1 Web 迁移(2b-3 + 2c)— 未完成,feature 级,有硬前提

把 web 工坊表层从旧 Python cache 路径切到 Node 路径,**深度耦合且半做会坏 UX**:

- **READ 重协调是核心难点(两个世界)**:能力装进 **Node** `super_plugin_runtimes`/`workshop_provenance`,但 web 现在只读 **Python cache**(`/api/plugins/status`)。只切安装不改读 = 装在 Node、UI 看 cache = **看起来什么都没装**。
- **新发现的硬阻断**:Node `GET /api/super-plugins` 受 `assertBoardOrgAccess` 板级鉴权(**非 loopback 开放**),故 Python 前门无法简单 loopback union 读它;web 直读需 ① 把它加进 `node_routes.json` 代理 ② 带板会话 ③ 新渲染 Node-installed 视图。
- **回归风险**:把旧 `/api/plugins/install-workshop` 改成 Node-only 会在 **Node 不在位时**打断当前可用的 Python-cache 安装。
- **验证前提**:真·浏览器 E2E(装→可见→配置→卸载)需一整套协同栈——**Node 未构建(无 dist)、无现成协同启动脚本**,本会话起不来。

**finish 路径(Codex 方案验收认可版 —— 中性 BFF,优于"web 直读 Node")**:

> Codex 评审裁决:**不要**让 web 直读 Node `/api/super-plugins`(会把 UI 绑死 Node 原生表结构 / board auth / pluginKey / provenance 细节,且 skill/company 还要再补 `/api/super-skills` 等)。
> **主路径 = Python apps/api 提供中性 `/api/capabilities/*` BFF,web 只消费中性面;Python BFF 再按 origin 分流到 Python cache 或 Node S4。** 这保留旧 cache 安装世界(避免 Node 不在位回归)、单一稳定合同、最易测。
> 阻断判定修正:②"Python 无法 union 读"过绝对——Python BFF 可**转发真实 board/session 鉴权**或在 local_trusted 下依赖 Node 行为(但**不能**拿 import HMAC/loopback 当万能读权限;read 至少保 board/org,uninstall 保 instance admin)。④"跑不了 E2E"部分错——无 dist 可 `tsx src/index.ts` fallback、`superclaw service` 能拉 sidecar;真阻断应表述为"必须用协同栈 + marker/health 证明 Node 在位,裸 Python/只看 web 不算 E2E;built dist/embedded 仅桌面打包验收才需"。

1. 起协同栈(`superclaw service` 经 tsx fallback 拉 Node sidecar + Python apps/api + web vite + R2 + 一个已发布并官方签名的能力),用 marker/health 证明 Node 在位。
2. **补齐中性 BFF 合同**(web 只认这套):
   - `GET /api/capabilities/installed`:**union** Python cache + Node installed,显式返回 `origin`(cache vs node-workshop)+ `kind`+`capability_id`+`version`+`native_key`+`configurable`+`uninstallable`;**绝不**只按 id/version 合并(plugin/foo@1 ≠ skill/foo@1)。
   - `POST /api/capabilities/uninstall`:传 `kind + capability_id/version + origin/native_key`,Python 按 origin 分流(node→`DELETE /api/super-plugins/:key`,注意 Node 删用 **pluginKey** ≠ 必然等于 capability id)。
   - 中性 config:Node-origin 无配置面时返回 `configurable:false`,**别**让 web 继续打 `/api/plugins/{id}/configuration`(对 Node-installed 会 404)。
   - 既有 `GET /api/capabilities/distribution` 返回 `{capabilities:[]}` 而 web 现期待 `{plugins:[]}` → web 必改。
3. web:install→`/api/capabilities/install`;list→`/api/capabilities/installed`;distribution→`/api/capabilities/distribution`(全三类卡片);uninstall→中性卸载。Node 不在位时 installed 端点明确返回 degraded/warning,install Node-origin fail-closed,**绝不静默显示"未安装"**。
4. **preview 实测**全流程后提交;再做 2e(旧 `/api/plugins/install-workshop` 退役为 plugin-only 别名/只读回退)。

**Codex 点出的真坑(实现时必处理)**:
- Node `GET /api/super-plugins` 列 **JS plugin + super plugin**,"Node 列出" ≠ "workshop official installed"——origin/provenance 必须分开,official 只认 provenance。
- `kind` 用**签名 raw kind**,installed 判断不能合并不同 kind 同 id。
- **JS-format workshop import 在 Node 里还没接**(`super-workshop.ts` 直接 throw "JS-format workshop import is not wired yet")——若工坊 `plugin` 含此格式,是硬产品缺口,需先接。
- Python BFF **不能绕权限**:read 保 board/org,uninstall 保 instance admin;local_trusted 仅本地,不得成 staging/production 隐形 admin 后门。

#### 7.1.2 Web 2b-3 已完成(commit `7f492c2a`,Codex 6 轮 PASS)

Web 工坊表层已迁到中性 `/api/capabilities/*` BFF:install→`/api/capabilities/install`(Node S4,不再开 cache 配置弹窗);distribution→`/api/capabilities/distribution`(plugin 安装门只收 kind==='plugin');installed→union cache(origin:'cache')+Node(origin:'node-workshop'),`node_available:false` 渲染 degraded notice;**IA 核心**=`catalogItemCardModel` 经 `enrichCardItemWithNodeInstall`(kind-aware identity 键)给**每张卡(含远端 overlay 卡)**贯穿 origin/configurable/native_key → 管理菜单对 node cap 隐藏 Configure(否则 404)、卸载按 origin+native_key 路由到中性 BFF;overlay **不进**全局 installedPluginKeys(cache-only)故旧 registry/readiness 面板不误判;Installed/Available 过滤复用同一 installed 判定;cache/node 同 identity 两卡不合并(card key 含 origin)。验证:`npm test --prefix apps/web` 全门绿(48 文件/604 测试,含 node 卸载 jsdom 交互 + selector 单测)。**下一片仅剩 2e(旧 `/api/plugins/install-workshop` 退役)。**

#### 7.1.1 后端 BFF 已完成 + Web 两轮实测发现(历史:2b-3 首版曾回退,已由 7.1.2 完成)

**后端中性 BFF 已全部完成 + Codex 验收(commit `62f5a68f`):** `GET /api/capabilities/installed`(union cache+Node,origin 标记,node_available)、`POST /api/capabilities/uninstall`(按 origin 分流)、kernel `capability_workshop_installed.py`(node 读只纳 `official && kind==="super"`、loopback、卸载按 native_key)、CLI `capabilities workshop installed`/`uninstall`。**所以 web 收尾只剩"消费 BFF + IA",合同已就绪。**

**Web(2b-3)尝试了 2 轮 Codex 后回退**——证明它是需 preview + IA 设计的深活,盲改不收敛。两轮 Codex 抓到的**必须在 web 收尾时处理的 IA 交互**(均已确认是真问题):
1. **install 切中性端点**(`POST /api/capabilities/install` {capability_id,version,kind}、解析 envelope、**不开 cache 配置弹窗**)——已验证正确,保留思路。
2. **distribution 切中性**(`/api/capabilities/distribution`,`workshopInstallableIds` **只收 kind==='plugin'**,防 skill/company 同 id 误判 plugin 安装门)——正确。
3. **degraded**:读 `node_available`,false 时渲染 notice,**绝不静默**——正确。
4. **⚠️ 核心 IA 难点(2 轮都卡在这,需 preview)**:把 Node 已装 overlay 到远端 marketplace 卡(让其显 installed 而非 available)后,**远端卡缺 origin/configurable** → 其管理菜单(`canCardManage` 对任何 installed 卡开)会:(a) 对 Node cap 仍显示 Configure(点击走旧 `/api/plugins/{id}/configuration` → 404);(b) 卸载传 `item.origin=undefined` → 落 cache 路由(删错 store)。**正解需把 origin/configurable enrich 到所有展示卡(含远端 overlay 卡),或让远端卡的管理动作 defer 到本地 installed 卡**——这要对照 `docs/capability-workshop-ia-redesign.md` 的卡片/管理模型设计,且必须 preview 实测 install→显示 installed→Configure 隐藏→按 origin 卸载 全流程。
5. **去重**:`installedCatalogItems` 跨 cache/node 不能简单按 id@version 合并(后端契约:不跨 origin/kind 合并);要保留可按 origin 管理的那张卡。

**结论:web 收尾 = 消费已就绪的中性 BFF + 按 IA 文档把 origin/configurable 贯穿到卡片管理层 + preview 实测。后端零阻塞。**

### 7.2 Slice 4 — 生产残留清理(待业主逐项批准)

早前真账号 E2E 在**生产**留下:`skill.superclaw-e2e-test-skill@0.0.1`(workshop 发布 + provenance)+ 2 个 R2 key
(`capabilities/skill/skill.superclaw-e2e-test-skill/versions/0.0.1/package.scskill`、
`capabilities/skill/<devkey>/versions/0.0.1/artifacts/<digest>`)。清理顺序:unpublish → 清 provenance → R2(最后,移 `/trash` 而非硬删)。**每步远端变更需业主逐项批准后才执行。**

**可行性勘察(本会话):本片在当前 worktree 不可安全执行**,且属破坏性远端生产变更(非代码,Codex 无法"验收"):
- **无 unpublish/revoke 工具**:CLI 无工坊能力 unpublish/撤销命令(`capability_workshop_app` 只有 validate/build/submit-review/sync-registry/publish-r2/install/installed/uninstall;无 unpublish)。
- **无 R2 删除/move 能力**:`capability_r2.py` 只有 fetch/list/publish,无 delete/move-to-trash;且 worktree 无 `cloudflare-r2.env` 凭证。
- **provenance 在哪**:生产 ClawHunt 侧(非本仓本地);清理需生产 API/DB 访问。
- **结论**:要做 Slice 4,要么(a)业主用生产凭证手动 unpublish + R2 控制台移 `/trash` + 清 provenance;要么(b)先在内核新增 unpublish CLI + R2 delete/move 能力(本身一个 slice,需 Codex 验收 + 凭证),再由业主授权执行。AI 不在无凭证、无工具、破坏性生产删除上自行动手。
