# 能力工坊信息架构(IA)重构设计

> **状态**:设计稿 v2(已纳入 Codex + Antigravity 第一轮对抗式评审的 12 项阻断修订)。待二轮三方复评双 PASS 后定稿立项。**尚未实现。**
> **触发**:业主上传 published 的三个能力(plugin/skill/company)后,发现 skill 在 skill 专属管理页不可见,而 plugin/company 可见;据此提出工坊 IA 重组。
> **方法**:主代理 + Codex(gpt-5.5)+ Antigravity(Gemini 3.1 Pro)对抗式评审(2026-06-26)。

## 0. 一句话

把能力工坊从「三个数据源割裂的并列 tab」重构为 **L0 统一发现首页(三类分栏)+ L1 三个一级分类专属管理页(目录 / 已安装 / 创建 / 上传 tab)**;**多源聚合下沉到后端 unified endpoint**(守 CLI 唯一事实源);三类生命周期语义 **kind-aware 不强行统一**;二级分类(category)**复用内核既有枚举**并迁移 workshop 模型;资产化复用**既有 `clawhunt_delivery` provenance**。

---

## 1. 触发问题与现状割裂(代码核实,锚点用符号防行号漂移)

### 1.1 触发
业主 published 三个能力:`dev.leon.vowel-stats`(plugin) / `commit-message-writer`(skill) / `dev.leon.content-polish-pod`(company)。plugin/company 在工坊可见,**skill 不可见**。

### 1.2 现状(`apps/web/src/App.tsx` 单体,~16K 行)
- 工坊 = `workspaceSurface === 'plugins'`,3 个并列 tab(由 `pluginStoreTab` 切换)。
- **Plugins / Companies tab**:聚合远端 published(`/api/plugins/workshop-catalog` + `marketplace-catalog` + `/v1/catalog`)+ 本地已装(`/api/plugins/status`)。✅ 远端可见。
- **Skills tab(割裂根因,两处不止一处)**:
  - (a) 过滤 memo `visiblePluginCatalogItems` 里 `pluginStoreTab === 'skills'` 分支 **`return false`**(排除所有远端 `pluginCatalogItems`)。
  - (b) **更外层**:catalog 列表渲染区有 `pluginStoreTab !== 'skills'` 门禁,使得 skills 分支里的 catalog 渲染**实际不可达**(Codex 评审发现:只改 (a) 远端 skill 仍不显示)。
  - 数据源仅 `loadNativeSkills()`→`/v1/skills`(本地 native skill)+ `loadSkillProjections()`(投射状态)。
  - skill 两套平行系统:native skill store(`/v1/skills`)vs governed skill-origin plugin catalog(`/api/plugins/*`);二者**不等价**(`tests/test_plugin_cloud_api.py` 明确覆盖)。
- `install-workshop`(远端 R2 下载装载)**仅支持 plugin**(`apps/api/main.py` `plugin_install_workshop` 显式拒非 plugin + 签名/digest/TOCTOU/rollback);skill/company 无远端安装路径。
- company:registry-only company 被**刻意设为不可实例化**(`catalog_resolver.py`,测试 `test_catalog_company_instantiable.py`);实例化走 `/api/team/bootstrap` + `instantiable` gate。
- **"marketplace" 分组**:`item.category || 'marketplace'` 的 fallback(`App.tsx` catalog 分组逻辑)——能力无 category 时的默认筐,**非交易系统**。
- category 现状:内核 `capability_atlas` **已有 category 枚举**,但 **workshop registry/catalog 模型没有 category 字段**,API 目前把 `category` 当 `kind` 投影(契约缺口)。
- provenance 现状:ClawHunt delivery ingestion **已写** `source.type = clawhunt_delivery` + `provenance.build_type = clawhunt_delivery`(`plugin_ingestion.py`)。

### 1.3 割裂清单
| 割裂 | 页面 | 根因(符号锚点) | 现象 |
|---|---|---|---|
| 远端 skill 不可见 | Skills | `visiblePluginCatalogItems` skills→`return false` **+** 外层 `pluginStoreTab !== 'skills'` 渲染门禁 | 只见本地 native skill |
| skill 无远端安装 | Skills | `install-workshop` 仅 plugin | 只能本地 build + 投射 |
| 能力堆默认筐 | 全部 | 无 category 字段 → fallback `'marketplace'` | 分组语义混乱 + 污染 §8 交易语义 |
| category 契约缺口 | 全部 | atlas 有枚举但 workshop 模型无字段、API 映射 category=kind | 无法按真实功能分组 |

---

## 2. 设计原则与铁律对齐

1. **发现 vs 管理分离**:L0 发现(看全三类),L1 管理(CRUD)。
2. **kind-aware,不强行统一语义**(铁律:表层零新增语义):plugin 装载 / skill 投射 / company 实例化本就异构,**不发明统一「安装」**。
3. **CLI 唯一事实源 + 聚合下沉后端**:L0 的多源 merge/去重**必须在后端 unified endpoint 完成**,前端只盲渲染。前端自行 `Promise.all` 三个 API + 写 merge,会造成「CLI list 看不到全貌、Web 能」的事实源分裂(agy 评审,§5)。
4. **category 复用内核单一源**:复用 `capability_atlas` 枚举,不新增前端猜测;workshop 模型补字段 + 迁移(§6)。
5. **资产化复用既有 provenance**(`clawhunt_delivery`),不前端新造字段(§8)。
6. **红线(两路一致)**:绝不为按钮完整,把「获取 skill / company」偷接到 plugin install 或本地 build 流;`install-workshop` 对非 plugin 永久拒绝;registry-only company 永不直接实例化。
7. **重构与改 IA 分离**:抽组件(非功能,UI 零变化)与改 IA(功能)**必须分阶段**(§9 P0 vs P2),不得同阶段搅动。

---

## 3. 目标 IA(两层)

### 3.1 L0「全部」聚合发现首页(新默认落地页)
- 纵向滚动,三 section(Plugins / Skills / Companies),每 section 聚合该类(远端 published + 本地,**后端已 merge+去重**)。
- 全局搜索 + 跨类快捷过滤(全部 / 已安装 / 可获取,语义 kind-aware,§4)。
- 每 section "查看全部 →" 进 L1 专属页。
- section 内未来按 `category` 二级分组(§6 就绪后)。

### 3.2 L1 三个一级分类专属管理页(各一个,tab 化)
- **目录**(远端 published,按该 kind 过滤 + kind-aware 获取动作)。
- **已安装 / 库**(本地,配置 / 卸载 / 更新 / 销毁)。
- **创建**(本地构建 / 新建)。
- **上传**(`submit-review` 发布)。
> 「商店 vs 库」分离落在 tab 层(目录=商店、已安装=库),kind 优先在外层保留 —— 二者融合。

---

## 4. kind-aware 语义(禁止统一成「安装」)

| kind | 目录(商店)动作 | 库动作 | 状态词 |
|---|---|---|---|
| **plugin** | 安装 | 卸载 / 更新 | 未安装 / 已安装 / 可更新 |
| **skill** | 查看(P1–P2)· 获取(P3) | 投射 / 取消投射 / 删除缓存 | 远端发布 / 本地存在 / 已投射 |
| **company** | 查看 · 导入模板(P3) | 实例化(走现有 gate)/ 打开实例 / 管理模板 | 模板已发布 / 模板已导入(可实例化)/ 已创建实例 |

- L0 卡片可统一视觉,**CTA 必须 kind-aware**(否则误导用户 skill 像 plugin 一键装、company 像插件装载)。
- 跨类过滤词用「可获取」而非「可安装」(plugin 才叫安装)。
- **「上传」三层区分**(实现者勿混):developer sign(开发者签名,已连通)≠ review publish(审核发布)≠ official co-signature(官方联署);上传不等于官方可信。

---

## 5. 数据源统一:后端 unified endpoint(重写,守 CLI 唯一事实源)

### 5.1 聚合下沉后端
- 新增内核/API **unified catalog endpoint**(如 `GET /api/catalog/all?kind=`):后端去 merge `workshop-catalog` / `marketplace-catalog` / `/v1/catalog` / `/v1/skills` / `status`,做完 identity 去重 + 状态 overlay,返回统一形状;CLI `capabilities list --all` 复用同一内核函数(事实源不分裂)。
- 前端 L0/L1 只调这一个端点 + 盲渲染,**不再前端 `Promise.all` + 双重 for**。
- **分页 / 过滤下推(agy 二轮阻断)**:unified endpoint **必须**支持 `?limit=&offset=`(或 cursor)+ `?q=` 搜索 + `?kind=` / `?category=` 过滤,**全部下推到后端**;绝不把聚合后的全量(生态扩大后可能数百上千条 + 大段描述/schema)一次吐给前端再前端搜索/分页(否则 L0 盲渲染会瓶颈/OOM)。L0 三 section 各自分页拉取。初期数据量小若暂不做,**须显式记为技术债**,不得默认全量。

### 5.2 Local > Remote state merge 规则(agy 阻断 #1)
- 同一 identity(kind + capability_id + version)既在本地又在远端 catalog → **合并为一张卡**,绝不出现两次。
- **远端数据 = 展示底座**(name/summary/category/trust/provenance);**本地状态 = overlay**(已安装 / 已投射 / 已实例化 / 配置 / 可更新)。
- 去重 key = kind-aware identity;冲突时本地状态字段覆盖远端自报状态。

---

## 6. category 二级分类(单一事实源 + 迁移,重写)

- **单一事实源决策**:复用内核 `capability_atlas` 既有 category 枚举(不新增 workshop 专属 enum,避免双源)。若 atlas 枚举不足,扩 atlas(仍单源)。
- **模型迁移**:workshop registry/catalog 模型**补 `category` 字段**(现缺);修正 API「把 category 当 kind 投影」的缺口,改为独立透传 category。
- **manifest**:`superclaw-plugin.json` / `SKILL.md` frontmatter / `superclaw-company.json` 增 `category`,CLI `validate` 按 atlas 枚举校验。
- **向后兼容迁移**:存量无 category 能力 → 默认组 `uncategorized`(**废弃 `marketplace` 默认筐命名**,把 `marketplace` 归还 §8 交易语义);迁移脚本/惰性回填。

---

## 7. skill / company 远端获取(精确落点语义,重写)

### 7.1 skill(Codex 阻断 #4;二轮:落点定为硬结论 + 最小契约)
- `install-workshop` 仅 plugin,**不复用**于 skill(红线)。
- **决策(非"建议"):** `capabilities get skill <id>` 的落点 = **native skill store**(`/v1/skills` 后端目录);**projection 永远显式 opt-in**(获取 ≠ 投射,投射是用户单独动作)。governed skill-origin plugin cache **不**作为落点(避免与 plugin universe 混淆 / 偷塞回 plugin install)。
- 获取流程:下载验证 `.scskill`(签名 + digest + 撤销名单)→ 落 native skill store → 用户显式 opt-in 投射到 runtime。
- **最小契约**:① 落地记录沿用 native skill store 既有 schema,`source` 标 remote-origin(与本地 build 区分);② 重复获取(同 `id@version`)= **幂等**(digest 一致 no-op;不一致按版本规则拒/替换,不静默覆盖);③ 撤销(revoked)→ native store 标记不可投射 + 提示,已投射的提示 re-evaluate;④ 更新(新版本)→ 新记录,旧投射**不自动迁移**(需显式 re-project)。
- 新内核能力 + CLI(`capabilities get skill <id>`)→ API → Web;绝不接 plugin install。

### 7.2 company(Codex 阻断 #2)
- **不能**把「下载 + 实例化」合成一个按钮。
- P3 = 下载 / 导入 / 验证 signed `.sccompany` artifact → 落**本地可信模板源**(使 registry-only → 可信模板)→ 再走**现有** `instantiable` gate + `/api/team/bootstrap` 创建 proposal/实例。
- 即「获取模板」与「实例化」是两步两态(状态词见 §4)。

---

## 8. 资产化 provenance(复用既有 canonical 字段,重写)

- **不前端新造**「源自交付」字段。复用既有 `source.type = clawhunt_delivery` + `provenance.build_type = clawhunt_delivery`(`plugin_ingestion.py`)。
- 蓝图定义:catalog unified endpoint 透传 provenance 到统一形状的 canonical 字段路径 + 值域;前端按该字段渲染来源徽章 + 来源筛选。
- 关联 marketplace 资产化路线图(见 `docs/company-marketplace-chat-design.md` 资产化章节 —— **依赖 PR#427 合并后该章节才在 main**;定稿前需复核引用,合并前用「PR#427 §7」标注)。

---

## 9. 分模块 + 分阶段(重写:加 P0 纯重构 + P1 接入方案 + 抽取顺序)

### 模块(按依赖)
| 模块 | 层 | 内容 | 依赖 |
|---|---|---|---|
| **A. category 契约** | 内核 atlas + workshop 模型 + CLI | 复用枚举 + 模型补字段 + 校验 + unified 透传 | 根 |
| **B. unified catalog endpoint** | 内核 + API | 后端 merge/去重/overlay + CLI list 复用 | 根 |
| **C. 工坊 IA 表层** | Web | L0 聚合 + L1 tab + 远端 skill 可见 + kind-aware CTA | B(可先于 A,无 category 版) |
| **D. skill/company 远端获取** | 内核 + CLI + API + Web | §7 落点语义 | 独立 |
| **E. 资产化来源承接** | unified 投影 + Web | §8 provenance 透传 + 筛选 | B + marketplace 资产化 |

### 分阶段
- **P0(纯重构,UI 零像素变化,agy+Codex 阻断)**:抽 `App.tsx` 组件,**不改任何 IA/UI**,全量回归通过为门。**抽取顺序**:① 纯逻辑(selector / filter / dedupe / CTA state)先出单测 → ② catalog card / list → ③ native skill grid → ④ developer upload panel → ⑤ company instantiate dialog。
- **P1(最小可见性修复,表层)**:修 Skills 割裂的**两处**(过滤 `return false` + 外层 `!== 'skills'` 门禁),让远端 published skill 可见;**视觉强隔离**——Skills tab 顶部 `[远端商店] / [本地可用]` 分段(或硬 Header),远端项只读(标 `远端发布`、禁操作、仅查看详情);搜索合并 + Local>Remote 去重(§5.2)。**不混排**。
  - **P1 与模块 B 的时序(agy 二轮阻断)**:P1 **不**写后端 unified endpoint(那是 P2/模块 B 的活,否则 P1 失去"最小燃眉"意义)。P1 允许一次**严格圈定 skills 的临时前端合并/去重 hack**——仅让远端 skill 与 native `/v1/skills` 并存可见,**绝不碰 plugin/company**;**显式标为技术债**,P2 落地 unified endpoint 时**铲除**此 hack。这样既不让 P1 膨胀,也不让前端合并扩散到全局违背 §5.1。
- **P2(表层,IA 大改)**:基于 unified endpoint(模块 B)立 L0 聚合首页 + L1 tab 化;**无 category 版**(category 在 P4)。
- **P3(内核+CLI+API+Web)**:skill/company 远端获取(模块 D,§7)。
- **P4(内核+表层)**:category 二级分类(模块 A)落地 + 前端分组。
- **P5**:资产化来源承接(模块 E,随 marketplace 资产化推进)。

> 依赖说明:模块表 C 依赖 B(非 A);category(A)只在 P4 影响分组,P2 做无 category IA —— 解除「B 依赖 A 但 P2 在 P4 前」的矛盾(Codex 阻断 #3)。

---

## 10. L0 / L1 状态面清单(新增,Codex 阻断 #8)

设计与验收必须覆盖(非仅 happy path):
- **加载态**:loading / error / partial outage(某源 5xx 时降级而非全空)。
- **生命周期**:pending review / published / revoked / replaced(版本被取代)。
- **信任**:official(联署验过)/ developer(签名)/ untrusted / local_dev。
- **可获取性**:published-but-not-installable(publish-without-upload 幽灵)/ entitlement-required / artifact 缺失。
- **本地/远端**:duplicate(同 identity 两源)/ 更新可用 / 配置缺失 / 权限不足。
- **kind 专属**:skill projection target(codex/claude/gemini 各自状态)/ company proposal vs instance / company 模板已导入未实例化。

---

## 11. 关键文件锚点(用符号,行号易漂移)

- **前端** `apps/web/src/App.tsx`:`visiblePluginCatalogItems`(skills→return false 割裂点)/ catalog 渲染区 `pluginStoreTab !== 'skills'` 门禁 / `loadPluginControl` / `loadNativeSkills` / `loadSkillProjections` / `installPluginCatalogItem`(kind 分支)/ `groupedPluginCatalogItems`(category fallback)。
- **后端**:`apps/api/main.py` `plugin_install_workshop`(拒非 plugin)/ workshop-catalog / workshop-distribution;`/v1/skills`;`/api/team/bootstrap`(company 实例化)。
- **内核**:`catalog_resolver.py`(instantiable gate)/ `capability_atlas.py`(category 枚举)/ `plugin_ingestion.py`(clawhunt_delivery provenance)/ `capability_devtools.py`(build/validate/sign)/ `ui_contracts.py`(契约单源)/ `plugin_cloud.py`(install-workshop)。
- **测试锚点**:`test_catalog_company_instantiable.py` / `test_plugin_cloud_api.py`(skill≠plugin catalog)。

---

## 12. 已知取舍 / 风险

- **`App.tsx` ~16K 行**:P0 纯重构先行是硬约束;混抽组件 + 改 IA = 反模式。
- **三类异构语义**:坚持 kind-aware,不为 UI 对齐牺牲概念。
- **远端获取是内核工作**:P1/P2 纯展示(只读)倒逼内核排期;绝不前端伪造。
- **category 契约变更**:复用 atlas 单源 + 向后兼容默认组;manifest 加字段需迁移。
- **unified endpoint**:聚合下沉后端,避免事实源分裂;但要定 partial-outage 降级策略(§10)。

---

## 13. 验收点(每阶段 Codex + agy 双 PASS + 本地全量门)

### 13.1 阶段验收
- **P0**:抽出组件有单测;**UI 截图/快照零差异**;全量回归绿。
- **P1**:远端 published skill 在 Skills 页可见且**视觉隔离**(远端商店区 vs 本地可用区);远端项只读;Local>Remote 去重无双卡;现有 plugin/company 行为不变。
- **P2**:unified endpoint 驱动 L0 三 section + L1 tab;CLI list 与 Web 同源;商店/库分离。
- **P3**:CLI `capabilities get skill/company` 内核跑通 → API → Web;skill 落 native store + opt-in 投射;company 走现有 instantiable gate。
- **P4**:category 复用 atlas 枚举 + workshop 模型字段 + 校验;前端分组;无 category 落 `uncategorized`。
- **P5**:资产化能力带 `clawhunt_delivery` provenance;工坊按来源筛选。

### 13.2 红线验收矩阵(Codex 阻断 #5,必测)
| 红线 | 期望 |
|---|---|
| 非 plugin 调 `install-workshop` | **拒绝**(永久) |
| publish-without-upload(无 R2 字节) | **不可装**(workshop-distribution 不列) |
| digest mismatch | **不落缓存** + 回滚 |
| feed 自报 `official` 但本地验签不过 | **不被信任**(无 official 徽章) |
| skill / company 卡片 | **不出现** plugin install action |
| registry-only company | **不可直接实例化**(须先导入可信模板) |
| 远端 skill/company 获取(P3 前) | UI 只读、操作禁用 |
| **P1 双门禁回归**:只移 `visiblePluginCatalogItems` 的 `return false`、未移外层 `pluginStoreTab !== 'skills'` 渲染门 | **测试必须失败**(钉死第二道门,防再漏导致远端 skill 仍不可见) |
