# 独立示例验证 · 2026-09-05

以下检查在 AwwO 新仓库的 `examples/knowledge-workbench/` 中执行。该路径包含空格，未复用旧 Agent 目录的依赖；模型、DOM、焦点和浏览器使用同一份示例源码。

环境：Windows、Node.js 22.16.0、Python 3.12.10、jsdom 29.1.1、Python Playwright 1.58.0。

| 命令 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 锁文件安装成功，39 个依赖包 |
| `npm test` | 31/31 通过 |
| `npm run test:dom` | 3/3 通过 |
| `npm run test:focus` | 8/8 通过 |
| `npm run test:repro` | Unicode 检索、治理依赖恢复两项原始复现断言通过；源码哈希前后一致 |
| `npm run test:unicode` | Unicode 17.0.0 固定源哈希及 1,585 条默认完整折叠映射一致 |
| `python tests/browser_smoke.py` | 1440/768/375/320px 通过，生成 5 张截图及结果报告 |

浏览器检查单独启动 `python server.py --port 4274`，并设置 `AWW_PREVIEW_URL=http://127.0.0.1:4274/`。检查后已停止该服务；未占用或重启原有预览端口。浏览器实际读取的是新示例的 HTML、CSS 和模块，320px 文档页截图也已人工核看。

原始复现脚本在整理前因引用未复制的 `artifacts/contract-review-repro.mjs` 失败；迁至 `scripts/` 并修复相对引用后通过。两处 DOM 测试改用本例的锁定 jsdom；模块导入直接使用文件 URL，以支持含空格的 Windows 路径。

这些结果仅覆盖本地演示与明确列出的检查，不证明真实认证、业务后端、服务端权限或完整读屏合规。生成报告、截图与缓存位于被 Git 忽略的 `artifacts/`，可按 README 命令重新生成。
