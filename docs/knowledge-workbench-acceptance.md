# 知识与产物工作台本地验收

验收日期：2026-10-01。基线：GitHub main `c64b51a633490af80a4b45e4ef0d677211ddc069`。

实现位于隔离的 detached worktree：`/Users/zhouxiansheng/awwo/AwwO-knowledge-workbench`。原 checkout 的未提交改动没有被带入或覆盖。本报告记录本地实现与验证，未执行远程推送、合并或生产部署。

## 已交付

- 租户知识库：原始资料、不可变修订、追加来源、可循环的知识关系、搜索、提案审核、版本恢复。
- 知识进入执行：将选定修订冻结到规划、节点、团队及图运行；保留来源身份与哈希，并计入上下文预算。
- 知识整理：可查询和恢复的整理运行，逐页校验固定来源，生成待审核提案。
- OpenMaus 可选 HTTP 桥接：服务端租户绑定、真实 Bot/任务列表、显式发送、持久回执、消息入库；断连不自动重发。
- 画布四窗：HTML、真实 WebGL 3D、逐页 PDF、ZIP/源码 IDE 预览。支持当前画布产物、本地文件及明确标记的本地示例。

完整使用方法、配置形状和格式边界见 [知识与产物工作台](knowledge-workbench.md)。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `npm run test:saas --prefix apps/web` | 73 个文件、929 项通过 |
| 最终 Three.js 导入兼容修复后的 `npm run test:previews --prefix apps/web` | 3 个文件、86 项通过 |
| `npm run typecheck:saas --prefix apps/web` | 通过 |
| `cd apps/web && npx tsc --noEmit` | 通过，兼容旧版 TypeScript moduleResolution |
| `npm run build:saas` | 通过；Vite 仍提示主包及 Three.js 分块超过 500 kB |
| `npm run test:saas:scripts` | 22 项通过 |
| 后端 PostgreSQL 集成、竞态检查及 vet | 342 个顶层测试全部分批通过 `-race`；`go vet ./...` 通过 |
| `git diff --check` | 通过 |

本机默认 Homebrew Node 因缺少 llhttp 无法运行，验收使用已安装的 Codex Node 24.19.0。未修改主机包管理配置。后端完整竞态检查涉及大量 Argon2 密码哈希，明显慢于定向测试。

首次 `npm run test:saas:backend` 在 245 个顶层测试通过后触发 Go 默认 10 分钟总超时，没有断言失败或竞态报告。随后用 `go test -list '^Test' ./internal/app` 枚举全部 342 项，从名称集合中排除已通过的 245 项，对余下 97 项执行 `go test -race -count=1 -timeout=20m -v -run '^(剩余测试名的精确并集)$' ./...`，209.584 秒通过，再运行 vet。逐项核对两个通过集合的并集等于完整测试清单；没有忽略失败项或跳过剩余测试，也没有修改密码哈希强度。分批清单与验证结果保存于 `.local/knowledge-evidence/backend-test-manifest.json` 和 `backend-verification.json`。

本轮日志位于本机 `/tmp/awwo-knowledge-{web-tests,backend-tests,backend-remaining,scripts-tests,build}.log`。这些日志是本轮证据，不随源码发布，也不是持续有效的线上状态证明。

## 真实浏览器验证

使用 Codex 内置浏览器操作实际 React 页面与本地 Go API；桌面视口为 1440 × 960，验证结束后恢复默认视口。没有用静态图片替代 PDF 或 WebGL。

| 操作 | 读回结果 |
| --- | --- |
| HTML 本地文件示例 → 开启交互 → 点击页面内按钮 | 按钮变为“交互成功 · 本地演示” |
| OBJ 本地文件示例 → 拖动旋转 | WebGL 模型实际显示，视角随拖动改变 |
| 两页 PDF 示例 → 下一页 | 页码 2 / 2，第 2 页实际渲染 |
| ZIP 源码示例 → 切换 `src/main.ts` | 显示文件树、TypeScript 正文及行号 |
| 导入原始资料 → 创建带来源提案 → 审核通过 | 资料 2、提案 0；知识页 v1；图谱出现引用关系 |
| 选中知识 → 加入任务 | 任务草稿与选定知识计数出现，没有自动执行 |
| 重启 API/Web → 再次读取知识库 | 原文、已发布页面、版本与引用关系仍在 |
| 打开未配置的 OpenMaus 面板 | 显示“尚未配置桥接”，没有虚构 Bot 或取消请求误报 |
| 弹窗键盘 Escape 关闭 | 关闭成功，恢复画布操作 |
| 最终四窗页面控制台 | 读取结果没有 error/warn 日志 |

截图在当前 worktree 的 `.local/knowledge-evidence/`，不包含账号秘密，也不作为源码提交：

- `four-previews.png`：同一画布中的四类实际渲染与交互结果。
- `knowledge-reviewed.png`：已发布知识、原件及引用图。

这些示例文件由浏览器本地生成，窗口明确标为“本地演示文件 · 非任务交付物”。本轮没有将它们描述成模型产出。

## 本地打开与恢复

本轮隔离实例使用 Web `5289`、API `8187`、PostgreSQL `55563`，与其他 checkout 的默认实例分开。

- 打开：`http://127.0.0.1:5289/?tenant=avKH7fYUAxytTi2ynTl8UJll8AvqNycO_&canvas=aW2d6AGxk5kBLbs8gERBMYHI_OV8XLwnn`
- 工作区：知识与交付物验收（本地）。画布：知识协作 · 四窗预览。
- 如需重新启动，在该 worktree 执行 `npm run dev:saas`。当前端口和本地初始化凭证保存在忽略文件 `.local/awwo-saas/.env`；不要提交或分享该文件。
- 本地文件预览存在浏览器内存中，刷新后需要重新选择文件或点击示例；知识库内容由数据库保留。

## 尚未验证的外部连接

本隔离实例没有配置付费模型凭证，也没有连接真实 OpenMaus 服务。模型知识整理与 Bot 执行的契约由测试 fixture 验证；真实模型输出质量、外部电脑控制和上游任务完成尚未实测。用户配置相应连接后，应执行一次范围明确的真实任务，核对实际产物和来源，再完成外部服务验收。

预览中的 IDE 是只读文件树与源码窗口，不是完整终端 IDE。PDF/3D 预览不自动做 OCR、语义提取或资料入库。上述能力与界面中的实际支持范围一致。
