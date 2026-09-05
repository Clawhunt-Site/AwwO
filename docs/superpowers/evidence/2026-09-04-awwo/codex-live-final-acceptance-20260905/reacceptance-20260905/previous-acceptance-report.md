# AWW-12 交付验收报告

结论：**部分检查通过，整体验收未通过；事项应为 blocked。** 已完成本轮标准制定、设计/代码核对和可执行验证；两项演示缺陷交 F/AWW-15 修复，浏览器验收依赖 AWW-11。没有部署或真实业务服务通过结论。

producer_node=V；contract_version=1.0；验收日期 2026-09-04；父运行 `6af0e76f-f933-4c03-a886-9934d09b489e`。验证期间为北京时间 23:45–23:49；精确 UTC 时间见各 JSON。来源为 AWW-12 说明、B v1 及 F 实际主入口交付；输入路径/哈希见 `source-manifest.json`。

## 范围与标准

验收工作区、身份演示、权限、文档治理、检索、看板、页面闭环及契约交接。详见 `acceptance-criteria.md` 的 V-01～15 与 AC-01～08 映射。真实账号、部署、外部集成本次不验收；真实认证、数据库约束/事务、持久化幂等、索引与审计只确认设计覆盖，运行状态为 not_run。

| 标准 | 状态 / 证据等级 | 实际结论 |
| --- | --- | --- |
| V-01 引用与交接 | passed / design | B/F 路径可定位；P/U/G 源哈希与 B 记录一致；静态声明七节点十二边，非真实绑定证明 |
| V-02 登录/退出/身份 | passed / mock；not_run / live | 演示取得身份，401 清屏；退出后受保护路由回登录；真实 Cookie、账号停用和回调未验 |
| V-03 权限与租户 | passed / mock；not_run / live | Viewer 拒绝写/成员/草稿/治理，Admin 目标限制、跨工作区资源与关联拒绝；真实撤权并发未验 |
| V-04 数据与版本模型 | passed / design+mock | 字段完整；草稿/发布 DTO 分离；旧版本与发布投影保存后不变 |
| V-05 治理生命周期 | passed / 已测 mock 子集 | 缺必填不能发布、409 不覆盖、归档退出检索；依赖失效问题见 V-10；不能外推完整质检已通过 |
| V-06 重试/幂等 | passed / DOM 传输；not_run / persistence | 显式重试保持同一 key；后台事务和幂等结果持久化尚无运行证据 |
| V-07 检索语义 | **failed / mock** | R1：Straße 查询命中1，STRASSE 命中0，违反 NFKC+casefold 集合等价要求 |
| V-08 发布过滤/分页 | passed / 已测 mock 子集 | 无草稿标题/正文/分面泄漏；分页不重不漏；归档/发布使旧 cursor 失效，保存草稿不改变发布水位 |
| V-09 发布看板 | passed / 已测 mock 子集 | 同夹具 total 等于 published_count；Viewer 无治理字段；503 不显示成功零值 |
| V-10 治理有效性 | **failed / mock** | R2：标签恢复后仍 blocked=1/unchecked=2，应为0/3，旧质检未失效 |
| V-11 切换工作区 | passed / DOM | query/category/tags/collection 均保留，目标无候选保留过滤值并显示空结果，返回原空间仍保留 |
| V-12 页面闭环 | passed / DOM；not_run / browser E2E | 登录、检索、保存/发布、看板、退出路径可执行；dialog/scroll 使用替身 |
| V-13 浏览器交互 | **not_run / environment blocked** | Playwright transport 创建进程阶段 PermissionError/WinError 5，尚未进入页面断言；无新截图、原生焦点或布局证据 |
| V-14 物料/未实现 | passed / static | 主入口有演示标识与中文文案；缺指标/回调有说明；没有用模拟曲线补齐指标 |
| V-15 缺陷交接 | passed / evidence | 两项有脚本、实际输出、归属和复验条件；F/AWW-15 为返工路径，AWW-11 为浏览器解阻路径 |

## 已执行的最小验证

1. 重跑 F 主入口 `tests/model.test.js` 与 `tests/ui-dom.test.js`：15/15 passed，见 `replayed-tests.tap`、`replayed-tests-status.json`。覆盖的是主入口 `.js`；未以未导入的额外 `.mjs` 实现充当运行证据。
2. 独立增加四类过滤条件保留及退出后路由检查：1/1 passed，见 `acceptance-dom.test.mjs`、`acceptance-dom.tap`。首次执行的目标页面等待条件过早，通过等待目标工作区实际渲染修正测试夹具后通过；F 应用未修改。
3. 加载原 F `server.py` 在临时回环端口提供原文件，入口及 7 个静态依赖均 HTTP 200；`/api/v1/session` 返回401，`/api/v1/workspaces` 返回503且明确未连接业务后端。见 `runtime-check.py/json`；临时服务已关闭。这不是认证与业务授权通过证明。
4. 浏览器尝试留有 `browser-error.txt`；环境拒绝发生在 Playwright 驱动启动阶段。没有绕过权限或重复启动尝试，也没有冒报页面测试失败。
5. AWW-13 独立一致性审查运行原 `createDemoService` 最小复现，两个期望/实际不一致，见 `contract-review.md`、`contract-review-repro.mjs/json`。复现脚本退出0仅表示记录完成，两个契约条件均 failed。

## 问题、负责人及复验条件

**AWW-15 / F 知识库 Web 工作台：** 修复 R1 完整大小写折叠与 R2 质检依赖有效性；代码定位、UI 复现、期望/实际、影响、修复建议完整写于 `contract-review.md` 和 AWW-15。提交新源码哈希，R1 两查询均命中1，R2 三草稿夹具恢复后0/3；复跑主入口15项与针对性回归。该修复无需等待真实账号或浏览器环境。

**AWW-11 / 环境管理员、F 与其独立复核责任人：** 提供允许运行浏览器的验收环境，由 F 执行已有 `tests/browser_smoke.py`，提交实际页面截图、1440/768/375/320 尺寸与焦点/键盘证据；V 回读后判断 V-13。两项代码修复不能自动解除此依赖。

**后续真实实现条件（不扩大本轮范围）：** 产品/U/B 冻结身份源、callback、会话与 CSRF；B 提供业务服务后才能验证服务端权限、版本事务/幂等、索引与审计。G/B 先冻结活跃贡献者、搜索趋势、过期和缺元数据指标字段及窗口。B 已记录审计90天与上游待定冲突，不能据设计执行清除。

## 事项处理记录

AWW-13 的内部协作审查产物已完成并回读。父运行关闭它时 API 拒绝 run ownership conflict：该子事项已被独立运行 `0a0ad2b4-e2b7-467e-b2b4-d03eb93d6da9` 接管。已通过评论 `2b63b57b-492a-46e6-9073-e6a61bca482a` 将证据及“回读后关闭、勿重复创建返工”交给实际持有运行；没有绕过所有权。该子事项状态以 `issue-readback.json` 为准。

AWW-12 最终依赖 AWW-15 返工与 AWW-11 浏览器验证，记录为 blocked；没有假设后台持续验收。本次源文件均只读，未安装依赖、修改 F/B、部署或访问真实外部业务系统。

最终 API 回读（2026-09-04T15:50:51Z）：AWW-12=blocked，blockers=AWW-11/AWW-15；AWW-13 已由持有运行关闭为 done；AWW-15=in_progress，F 运行 e2557714-857b-4cff-a838-b54402eb6e3a 已开始返工。见 issue-readback.json。
