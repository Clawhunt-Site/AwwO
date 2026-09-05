# AWW-12 复验报告 v2

**结论：本轮契约与前端演示验收完成，已确认的两项缺陷关闭，有界浏览器检查通过；AWW-12 可标记 done。** 通过范围为设计契约、内存演示、DOM 业务流程及已执行的浏览器 smoke，不代表完整 SaaS、真实后台或生产验收。

日期：2026-09-05（北京时间）；运行 `cb0e4332-1797-4bb1-8545-18ced4772991`。本报告取代上一轮 AWW-12 的两项 failed 和浏览器缺证据结论；原始报告、失败复现和源码快照继续保留。15 项标准仍以 `../acceptance-criteria.md` 为准，没有改动通过条件。

## 输入与版本

- B 契约 `backend-contract-v1.md` 及其 P/U/G 来源哈希与首次验收一致；B 仍为 design 交付。
- F 的旧 `artifacts/delivery.md`、`checks.json` 仍写浏览器 blocked，已被 AWW-15 修复交付和 AWW-11 的 9 月 5 日最终复核补充取代。本次不据旧摘要继续判定浏览器受阻。
- AWW-15 的全部 11 项记录哈希与当前文件一致；本次测试前后 19 项源码/测试/报告哈希未变。已经保存到 `reviewed-source/`。
- 当前关键文件：`src/demo.js`=`6e63d6ee802c674c3854ecedb6679671b7bcfb5aa90a3b0fc0b3dc297a238ec5`；`src/unicode-casefold.js`=`d67cfb8b6736b94be40b03145b3d8a21af74e7228cabcaa127eab35bd5f129e5`；`src/accessibility.js`=`f2d0ab09ebda0b8efad83ebd3d68bbf8317dcafa8fa42691fb27ec07040f6748`。

完整来源、哈希和回读时间见 `verification.json`。当前输入副本在 `upstream-evidence/`；宿主截图副本在 `host-browser/`。

## 两项缺陷复验

使用原验收夹具，只有新证据子目录所需的 import 相对路径调整，另加独立断言；没有改变业务步骤或降低期望。执行 `node artifacts/reacceptance-20260905/assert-repro.mjs`，2026-09-04T16:23:10Z 记录结果。

| 原缺陷 / 标准 | 当前实际 / 期望 | 状态 |
| --- | --- | --- |
| R1 / V-07：Straße 对 STRASSE 漏召回 | 原词查询 total=1，折叠查询 total=1；两者均应为1 | passed / mock，关闭 |
| R2 / V-10：标签恢复后旧质检仍有效 | 停用标签发布仍422 QUALITY_FAILED；恢复后 blocked=0、unchecked=3，版本状态 unchecked | passed / mock，关闭 |

修复还覆盖关联标签/集合/成员/规则修订变化、依赖改回原值、无关变更不失效、新草稿隔离与历史质检保留，见新增回归输出。固定完整折叠映射与宿主 NFKC 的版本边界沿用 AWW-15 说明，不将其称为另一种标准化算法。

## 独立执行与证据回读

| 检查 | 结果 | 本次证据 |
| --- | --- | --- |
| 原12项模型/传输、新7项治理检索回归、12项Unicode回归 | 31/31 passed，无跳过 | `model-regression.tap` |
| 原应用DOM 3项 + V四筛选/退出检查1项 | 4/4 passed，无跳过 | `ui-dom.tap` |
| 最新可访问性 helper 局部焦点回归 | 8/8 passed，无跳过 | `modal-focus.tap` |
| 原始两个缺陷最小复现及严格断言 | R1/R2均 passed | `contract-review-repro.json`、`repro-status.json` |
| 宿主原浏览器夹具 | 14/14 passed，无 executionError | `upstream-evidence/aww-11-browser-evidence/results.json` |
| 宿主实际应用 smoke | passed，1440/768/375/320px | `upstream-evidence/browser/result.json` |
| 浏览器证据与当前源匹配 | 4项夹具源码、2个原harness一致；11张截图哈希/尺寸一致 | `verification.json` |
| 独立截图观察 | 实际查看320px应用、桌面应用、强制颜色焦点3图，未见可见阻断 | `browser-review.md`，AWW-18 |

宿主执行来源为 AWW-11 的 local-board 评论 `731d2ca9-825d-44fe-8a18-9b243253df0c`，本次已经 API 回读并保留 `host-provenance-comment.json`。执行时间 2026-09-04T16:17:24.473Z，Chrome 152.0.7977.82。当前沙箱没有重跑浏览器，也未改变进程权限。

应用 smoke 覆盖入口、发布文档列表、跳转链接、dialog Escape/焦点恢复、移动导航、页面横向溢出和 page errors；它不是完整浏览器业务链路。应用 JSON 没有内嵌全量源码清单或逐键 trace，其来源依赖宿主评论、原 smoke 脚本哈希、AWW-15 的应用源码哈希及共享样式/helper匹配；不伪称报告包含更多信息。

## 15项标准的最终处置

| 标准 | 最终判定与适用层级 |
| --- | --- |
| V-01 引用/交接 | passed / design；原七节点十二边静态检查保留，当前契约哈希未变；不证明真实绑定 |
| V-02 身份演示 | passed / mock+DOM；真实账号/会话生命周期仍 not_run |
| V-03 权限边界 | passed / 已测 mock 与设计；真实后台授权、撤权竞争及最后 Owner 并发仍 not_run |
| V-04 数据/版本 | passed / design+mock；真实数据库约束仍 not_run |
| V-05 治理生命周期 | passed / 已测 mock，包括修复后的依赖失效；实际存储持久性仍 not_run |
| V-06 重试/幂等 | passed / DOM传输；服务端事务/outbox/持久化幂等仍 not_run |
| V-07 检索语义 | passed / mock；R1关闭 |
| V-08 发布过滤/分页 | passed / 已测 mock；真实索引水位及缓存撤权仍 not_run |
| V-09 发布看板 | passed / 已测 mock；同范围数据及503处理已覆盖 |
| V-10 治理有效性 | passed / mock；R2关闭，旧失败记录保留而当前状态归unchecked |
| V-11 工作区切换 | passed / DOM；四类筛选保留、目标空结果及退出保护复跑通过 |
| V-12 页面业务闭环 | passed / DOM；完整浏览器业务闭环仍 not_run，浏览器只接受上述smoke范围 |
| V-13 有界浏览器 | passed / host evidence readback；原缺证据阻塞解除 |
| V-14 物料/未实现 | passed / static；演示标识与缺指标说明保留，旧交付摘要以本轮补充为准 |
| V-15 缺陷/证据交接 | passed；原两缺陷关闭，AWW-18独立复核完成，当前无验收范围内阻塞 |

## 非阻塞观察与保留范围

截图中搜索框左侧图标与占位文字起始字符略有叠压，桌面工作区选择器角色尾部截短。没有阻断操作的证据，作为低影响排版观察保留于 `browser-review.md`，不撤销已通过的有界检查。

真实账号、真实部署及外部集成本次明确不验收。真实 IdP/callback、服务端授权/事务/审计、完整浏览器业务端到端、完整 WCAG/读屏、性能与生产环境仍无本轮通过结论。扩展看板指标及技术选型继续按 B/U/G 的既定待定项处理，不为关闭本事项虚构实现或扩大授权。

原 blocker AWW-15 和 AWW-11 均已 done；AWW-18 的内部截图复核亦 done。AWW-12 完成的是本次交付验收与报告；不更改其他事项对真实服务接入的范围或状态。最终 API 状态以本目录 `issue-readback.json` 为准。
