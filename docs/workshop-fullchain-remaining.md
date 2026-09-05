# 能力工坊全链 —— 未完成 / 待办清单

> 分支 `feat/workshop-plugin-company-fullchain`(基于 `dev/server-refactor`)。
> 已完成的内容见 `docs/workshop-fullchain-status.md`(§一~§七)。本文件只列**尚未完成**的部分,便于下一会话直接接力。

本会话已把工坊「下载 → Node S4 落地 → 列出 → 卸载」全链经中性 `/api/capabilities/*` 贯通 **CLI + API + Web**,旧 `/api/plugins/install-workshop` 软弃用(均 Codex 单顾问验收)。以下为剩余项。

---

## 1. Slice 4 — 生产残留清理(阻塞:无工具 + 无凭证,且是破坏性远端操作)

**残留物(早前真账号 E2E 在生产 ClawHunt 留下)**:
- 工坊发布项 `skill.superclaw-e2e-test-skill@0.0.1`(+ provenance 行)。
- 2 个 R2 key:
  - `capabilities/skill/skill.superclaw-e2e-test-skill/versions/0.0.1/package.scskill`
  - `capabilities/skill/<devkey>/versions/0.0.1/artifacts/<digest>`

**为什么本会话没做**:
- CLI 工坊命令组**无 unpublish/revoke**;`capability_r2.py` 只有 fetch/list/publish,**无 delete/move-to-trash**;worktree **无 `cloudflare-r2.env` 凭证**;provenance 在**生产 ClawHunt 侧**。
- 这是**破坏性远端生产删除**(非代码),Codex 无法"验收";按铁律,AI 不在无工具/无凭证下自删生产。

**两条收尾路径(择一)**:
- **(a) 业主手动**(最快、最稳):用生产凭证 unpublish 该 skill → 清 provenance 行 → R2 控制台把 2 个 key **移 `/trash`(非硬删,可逆)**。顺序:unpublish → provenance → R2(最后)。
- **(b) 先造工具再授权执行**:在内核新增 `capabilities workshop unpublish` CLI + `capability_r2.py` 的 `delete/move-to-trash` 能力(本身一个 slice,需 Codex 验收 + 配置凭证),再由业主授权运行。

---

## 2. node-workshop 已装视图:当前仅覆盖 PLUGIN(skill/company 待补)

`/api/capabilities/installed` 的 node-workshop 来源建在 Node `GET /api/super-plugins`(plugin runtime catalog,且只纳 `official && kind==="super"`)。**workshop 安装的 skill / company 落在别的 Node store**(全局 skill store / companies),无跨 kind 的 provenance 列端点,故目前**不在已装 union 里**。

**待补**:Node 侧加一个跨 kind 列 `workshop_provenance` 的读端点(plugin/skill/company),BFF `installed` 再 union 进来;前端 `nodeCapToCatalogItem` 已支持 skill/company kind,接上即可。

---

## 3. JS-format 工坊 plugin 导入未接(Node 侧硬缺口,fail-closed)

`server/server/src/routes/super-workshop.ts` 对**无 super manifest 的 Paperclip 原生 JS plugin** 直接 `throw "Paperclip JS-format workshop import is not wired yet"`。即:**super-format plugin / skill / company 经 Node S4 正常安装,JS-format plugin 安装会 fail-closed 502**。

**待补**:接 Node 的 `installPaperclipJsPlugin`(unpacked dir → Paperclip loader)。在此之前,工坊若发布 JS-format plugin,前端点安装会得到通用 502(不是静默坏,但装不上)。

---

## 4. 旧端点硬退役(可选,当前为软弃用)

`/api/plugins/install-workshop` 当前是**软弃用**(行为不变 + `deprecated:true` + 日志 + docstring 指向中性端点),保留了硬化 cache-install 与纯 Python(无 Node)安装能力。若业主决定**彻底铲除 cache 安装世界**:改为 plugin-only 硬别名(委派给 `install_published_capability` 桥)或 410 Gone,并重写其 cache 行为测试为桥委派测试。**取舍**:硬退役会让纯 Python 部署失去工坊安装(回归)——需业主确认部署形态恒为 coexistence(Node 在位)后再做。

---

## 5. 非阻断 backlog

- Codex 的非阻断建议:给 dev CLI `ensureDevWorkspaceBuildDeps` 的 pre-import spawn 传 scrubbed env(该路径结构上不携带收据 key,纯纵深)。
- 收据 key 同 UID 局限:本地 0600 文件同 UID 可读(与 relay/escrow 等所有本地密钥一致),真隔离需 OS 沙箱——**业主已接受**为既定姿态,记此以免重复纠结。

---

## 6. 推 PR 前的交付门(流程)

远端 CI 暂停期,推 PR 前在隔离 worktree 跑通完整本地门:`scripts/run-ci-tests.sh`(两阶段)+ `ruff check packages apps` + `npm test --prefix apps/web` + `npm run build --prefix apps/web` + server `tsc --noEmit` + 相关 vitest;并先 `git fetch` 吸收最新 `origin/main`(尤其前端)再发 PR。绝不 force-push 覆盖他人。
