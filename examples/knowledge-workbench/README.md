# 团队知识库示例

这是 AwwO Agent 画布生成并经过后续修复的可运行前端示例。演示登录、数据与权限模型均在浏览器内存中，刷新后重置。真实身份源、业务后端、数据库和生产部署尚未接入。

## 环境与启动

- 运行页面：Python 3.11 或更新版本，无 Python 运行依赖。
- 运行 JavaScript 测试：Node.js 22.16+（22.x）或 24+，以及 npm。锁定的 jsdom 是测试依赖，不会进入页面。
- 浏览器检查：另需 Python Playwright 和 Chromium，安装方法见下文。

在本目录运行：

```sh
python server.py --port 4173
```

打开 <http://127.0.0.1:4173/>。已有服务占用该端口时，通过 `--port` 换一个端口。页面不需要构建，不访问 CDN；ES modules 需要 HTTP，不能直接双击 HTML。

默认演示模式始终显示横幅。选择 Owner / Admin / Editor / Viewer 后进入工作区；第二个工作区固定为 Viewer。角色选择器仅用于演示与测试。

`?mode=live` 使用同源 `/api/v1` 接口适配。当前服务器没有业务后端，`/api/v1/session` 返回 401，其余 API 返回 503；不会模拟真实登录或声称联调成功。真实接入需要身份源、服务端 Cookie、CSRF 和回调适配。

## 安装与检查

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:dom
npm run test:focus
npm run test:repro
npm run test:unicode
```

- `npm test` 检查模型、接口适配、检索、治理状态与 Unicode 全表一致性。
- `test:dom` 执行实际应用的 DOM 测试；`test:focus` 检查模态焦点边界。两者使用本例锁定的 jsdom，不依赖其他工作区。
- `test:repro` 重跑两项原始业务复现，断言 Unicode 检索和治理状态修复，并将结果与源码哈希写入被 Git 忽略的 `artifacts/`。
- `test:unicode` 只校验固定 Unicode 数据与生成模块，不下载或修改文件。生成方法与许可证见 [Unicode 数据说明](data/unicode/17.0.0/README.md)。

真实浏览器检查：

```sh
python -m pip install -r requirements-browser.txt
python -m playwright install chromium
python tests/browser_smoke.py
```

运行脚本前须启动示例服务器。自定义端口用环境变量指定，例如 PowerShell：

```powershell
$env:AWW_PREVIEW_URL = 'http://127.0.0.1:4274/'
python tests/browser_smoke.py
```

macOS/Linux 可用 `AWW_PREVIEW_URL=http://127.0.0.1:4274/ python tests/browser_smoke.py`。脚本验证 1440/768/375/320px 下的登录、文档列表、跳转链接、弹窗与移动导航的 Escape/焦点行为、页面错误和横向溢出，生成 `artifacts/browser/` 报告及截图。它不证明真实认证、服务端授权或完整读屏合规。

## 文件与设计文档

主入口是 `index.html` → `src/app.js`，其依赖为 `api.js`、`demo.js`、`copy.js`、`accessibility.js` 等；样式入口为 `src/styles.css`。`src/*.mjs` 和独立可访问性夹具是原节点的补充交付，不是第二个应用入口。

[设计契约](docs/contracts/README.md)包括架构、身份权限、数据治理、后端接口、上线物料与验收标准。它们记录设计边界和验收预期，不等于相关后端已经实现。本例不包含运行凭据、Agent API 回执、旧会话日志或重复快照。

所有测试产物、浏览器截图、依赖和 Python 缓存均不纳入源码。Unicode License V3 保留在 `data/unicode/`；其他许可遵循 AwwO 根目录的声明。
