# AWW-15 修复交付

2026-09-04。结论：R1/R2 已修复，主入口验证通过；提交 V / AWW-12 回读。

## 变更

- R1：`src/demo.js` 的检索查询、标题与正文统一先做 NFKC，再调用 `src/unicode-casefold.js` 的 Unicode 17.0.0 默认完整折叠。固定官方 C/F 共 1,585 条映射，排除 S/T；无需运行时第三方依赖或网络请求。字典名称的既有去重/排序规则保持原样。
- R2：质检记录在内部绑定精确文档 revision、版本 ID、规则 revision、关联分类/标签/集合 revision 和状态、负责人 membership revision/状态/角色。当前草稿只使用仍有效的质检记录；依赖变化后看板、版本列表和版本详情统一显示 unchecked。历史 QualityResult 保留原始结果，不重写历史失败，不自动重新发布。
- 新增 `tests/demo-regressions.test.js`，覆盖标题/正文/查询折叠、标签与集合恢复、成员恢复/移除/角色改变、字典改名、规则修改、依赖变回原值、无关变更、新版本隔离、历史记录保留及 Viewer 边界。
- `npm test` 已纳入新增业务回归与 Unicode 全表测试；`npm run test:repro` 在验收方原始复现后执行断言并记录源码哈希。

## 验收复现

验收方脚本复制到 `artifacts/contract-review-repro.mjs`，SHA-256 为 `f7e781e0840f2ff6963d350b900ec4634541e7a57b41fad2c38366aeb97059b5`。原始脚本未改动，原作者目录未写入；新增包装器提供断言，不能把原始脚本退出 0 独立解释为通过。

| 检查 | 修改前实际 | 期望 / 修改后实际 |
| --- | --- | --- |
| R1：Straße 查询 | total=1 | total=1 |
| R1：STRASSE 查询 | total=0 | total=1 |
| R2：标签停用后的发布 | 422 QUALITY_FAILED / REF_INTEGRITY | 相同失败，未推进发布指针 |
| R2：标签恢复后的 blocked / unchecked | 1 / 2 | 0 / 3 |
| R2：当前草稿版本 quality_status | failed | unchecked |

修改前证据：`aww-15-repro-before.json`、`aww-15-regressions-before.tap`（7 组中 5 组失败）。修改后期望/实际、运行时版本、源码哈希和时间均在 `aww-15-final-verification.json`；复现期间源文件哈希保持一致。

## 最终验证

- `npm test`：31/31 通过（原有模型/传输 12 + 新增主入口回归 7 + Unicode 回归 12），无跳过。
- `npm run test:dom`：原有真实应用脚本 JSDOM 3/3 通过，无跳过。
- `npm run test:repro`：两个原始复现及新增断言通过。
- `node scripts/generate-unicode-casefold.mjs --check`：固定数据 SHA 与生成产物一致。
- Unicode 回归独立读取官方数据，验证全部 C/F 映射与全部未映射 Unicode 标量、S/T 排除、默认土耳其 I、非拉丁/补充平面、代理码元、幂等及不依赖宿主大小写转换。

最终日志：`aww-15-final-tests.tap`、`aww-15-final-dom.tap`、`aww-15-final-repro.log`、`aww-15-unicode-generator-check.json`。

## 交付哈希

| 文件 | SHA-256 |
| --- | --- |
| src/demo.js | `6e63d6ee802c674c3854ecedb6679671b7bcfb5aa90a3b0fc0b3dc297a238ec5` |
| src/unicode-casefold.js | `d67cfb8b6736b94be40b03145b3d8a21af74e7228cabcaa127eab35bd5f129e5` |
| tests/demo-regressions.test.js | `4c0581ad1997522e6e5a24b8a6a1756e98adb1044b7fbb603115dc8408f89e2c` |
| tests/unicode-casefold.test.js | `ff86cafa6c92e5d385d7dddc3e49f793c095ea2d4ffd4166c50026c0654be26a` |
| 官方 CaseFolding.txt | `ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183` |

`src/app.js`、`src/api.js`、原有模型与 DOM 测试哈希和修改前一致。B 契约仍为 `1982adc830675f0131cd30bfba6a32776f3a54026caec1efa2ab13e4cdebdf86`，未修改。

## 适用边界

这是内存演示及 JSDOM 验证，不是实际浏览器、真实服务或部署验收。AWW-11 浏览器 blocker 独立保留。NFKC 使用宿主 JavaScript 的 Unicode 数据（本次 Node 22.16.0 / ICU 77.1 / Unicode 16.0），完整折叠表固定为 Unicode 17.0.0；组合操作不等同于会移除默认可忽略字符的 NFKC_Casefold。

并行期间出现 harness 对 AWW-16/AWW-17 的重复执行，已通过子事项评论协调接口并重新验证当前主入口。最终采用内联生成的 `unicodeCaseFold` 模块；未采用的独立子代理版本保存在 `aww-16-local-snapshot/`，相关历史报告明确标注为快照证据，不能替代本报告的最终验证。

后续复核责任人：V（agent 513806c8-269e-4221-a536-b52956f519ce）/ AWW-12。无需就本修复扩大后端或部署范围。

交接状态：实现、证据与 done 状态已成功写入并回读 AWW-15。直接向 AWW-12 追加通知被事项 API 拒绝（`Issue is outside this actor's authorization boundary`），没有发送成功。V 可从 AWW-15 的父子关联与本工件回读；未越过该授权边界或更改 AWW-12 状态。
