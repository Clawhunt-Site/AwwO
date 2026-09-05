# AWW-11 有界浏览器复核通过

2026-09-05（北京时间）。本轮 `b972b3ad-30ed-4679-813b-79bdf02cbaa9` 按 local-board 评论 `731d2ca9-825d-44fe-8a18-9b243253df0c`，仅回读宿主证据、核对哈希和检查现有截图。**原 AWW-11 的有界浏览器复核通过，满足关闭条件。**

## 实际回读

| 证据 | 结果 |
| --- | --- |
| `artifacts/aww-11-browser-evidence/results.json` | `checkedAt=2026-09-04T16:17:24.473Z`，Chrome `152.0.7977.82`，原 **14/14** 断言全部通过，无 executionError |
| 曾失败的 `Modal contains keyboard focus` | 当前为 true；帮助弹窗 Tab / Shift+Tab 包含性通过，Escape 关闭和触发者焦点恢复通过 |
| 夹具响应式 | 320/375/768/1280px 均无页面横向溢出；320px 下 200% 根字体压力检查通过（不等同浏览器缩放） |
| 夹具其他交互 | skip link、帮助触发器、模态打开、表单错误焦点/描述、状态更新、强制颜色下当前导航焦点标识均通过 |
| `artifacts/browser/result.json` | status=passed；实际应用 1440/768/375/320px，演示入口、文档列表、skip link、dialog Escape 焦点恢复、移动导航、横向溢出及 page errors 检查通过 |

宿主执行、退出码 0 及运行上下文来自上述 local-board 评论；本轮实际读取了两份报告。未在沙箱重新执行浏览器。

## 哈希与断言完整性

报告中 `tests/responsive-accessibility.html`、`src/styles.css`、`styles.css`、`src/accessibility.js` 的四个 SHA-256 均与当前文件一致。

- 修复模块：`src/accessibility.js` = `f2d0ab09ebda0b8efad83ebd3d68bbf8317dcafa8fa42691fb27ec07040f6748`。
- 原 harness：`artifacts/aww-11-browser-review.mjs` = `3103ca71da5c2fe844c53d521ee1b98086eb0ea4ee6d5133eab15c199667087d`，与修复前基线一致。
- 原应用 smoke：`tests/browser_smoke.py` = `0b543223000de15a3126e08d9471c1aaee9b793f21c4774b1aa2cf32900971bd`，与修复前基线一致。
- 当前通过报告：fixture JSON = `0189f0951b329ba6a096a10269036d17fe70822c721c803ec0530c6911b36966`；application JSON = `8d5fc6dad23718512df3a0921aa27b4ca8de30cad6b39212a0025b5a4d014012`。

没有修改原 harness 或断言。前轮局部回归 8/8、应用 DOM 回归 3/3 是补充证据，本轮关闭依据为真实浏览器通过结果及源码匹配。

## 截图检查

清点了两个证据目录的 **11 张 PNG**，核对文件头、尺寸、更新时间及哈希。实际查看了以下 4 张代表截图：

- `artifacts/aww-11-browser-evidence/fixture-320.png`：窄屏控件和长文本重排；成员表格内容位于局部滚动容器内。
- `artifacts/aww-11-browser-evidence/forced-colors-current-focus.png`：当前导航链接具有可见焦点轮廓。
- `artifacts/browser/documents-320.png`：应用移动布局、筛选单列和可见导航开关焦点。
- `artifacts/browser/documents-desktop.png`：应用桌面侧栏、筛选区与文档卡片布局。

上述截图未见阻止本次有界交付的页面级横向裁切；无横向溢出的量化结论来自原浏览器断言。截图本身不替代键盘交互测试。

完整回读清单保存在 `artifacts/aww-11-modal-focus/final-evidence-readback.json`。

## 补充信息与保留限制

local-board 同时报告了独立宿主旧/新 helper 对照：旧模块正反首个 Tab 到 BODY / hasFocus=false；当前模块正反各 3 次保持“知道了”按钮焦点，Escape 恢复通过。这是评论提供的补充证据；本轮未重演或读取额外逐键 trace，正式判定不依赖该补充描述。

通过范围是交付夹具及实际应用的上述响应式、焦点和交互检查。**不代表完整 WCAG、屏幕阅读器、真实身份、后端权限或生产验收。** 沙箱启动限制没有改变；宿主执行解除了本事项缺少浏览器证据的阻塞。

本轮未修改代码、未新增任务、未启动 monitor、未手动唤醒其他 Agent。AWW-11 可正式标记 done。
