# 知识与产物工作台本地验收

验收日期：2026-10-01。基线：GitHub main `c64b51a633490af80a4b45e4ef0d677211ddc069`。

实现位于隔离的 detached worktree：`/Users/zhouxiansheng/awwo/AwwO-knowledge-workbench`。原 checkout 的未提交改动没有被带入或覆盖。本报告记录本地实现与验证，未执行远程推送、合并或生产部署。

## 已交付

- 租户知识库：原始资料、不可变修订、追加来源、可循环的知识关系、搜索、提案审核、版本恢复。
- 知识进入执行：将选定修订冻结到规划、节点、团队及图运行；保留来源身份与哈希，并计入上下文预算。
- 知识整理：可查询和恢复的整理运行，逐页校验固定来源，生成待审核提案。
- 内置执行助手：托管真实固定提交的 OpenMaus 开源核心，复用 AwwO「我的引擎」，自动建立本次 Bot 与 Docker 工作区；支持历史恢复、审批、问题回答、停止、真实产物发布和知识归档。旧外部桥接仅保留为高级 API 兼容。
- 画布四窗：HTML、真实 WebGL 3D、逐页 PDF、ZIP/源码 IDE 预览。支持当前画布产物、本地文件及明确标记的本地示例。

完整使用方法、配置形状和格式边界见 [知识与产物工作台](knowledge-workbench.md)。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| SaaS 标准测试脚本，追加 `--maxWorkers=2` | **74 个文件、948 项通过**，358.01 秒 |
| `tsc --noEmit -p tsconfig.saas.json` | 通过 |
| `tsc --noEmit -p tsconfig.json` | 通过 |
| `build:saas` 对应 Vite 构建命令 | 通过，27.03 秒；仍提示主包及 Three.js 分块超过 500 kB |
| `node tests/static-ui.test.mjs` | 通过 |
| 默认旧版 Web 测试脚本 | 未能启动：独立 `server/ui` 缺少 `@mdxeditor/editor/style.css`，不是通过 |
| 内置执行后端 `go test -race ./internal/app -run Computer -count=1 -v -timeout=4m` | 4 项通过，76.348 秒；包括真实 PostgreSQL 集成 |
| 空白问题回答不消耗审批的定向 race 回归 | 通过，9.186 秒；仍使用 `TestPostgresComputerUncertainApprovalIsNeverAutomaticallyRepeated` |
| **全后端 `go test -race ./... -timeout=20m`** | **1200.302 秒超时，未完成，不能标记通过** |
| `go vet ./...` | 通过，无诊断 |
| OpenMaus worker 普通测试 | 16 项：11 通过，5 个真实集成场景默认显式跳过，0 失败；worker TypeScript 通过 |
| 共享模型代理测试 | 8 项通过，strict TypeScript 通过；含 Google 个人模型绑定后的实际请求兼容回归 |
| SaaS setup / 启动脚本测试 | 24 项通过 |
| OpenMaus 真实核心 + Docker 显式集成 | 5 个场景通过，见下节；另有并发同答复幂等与完整审批参数正向回归通过 |
| worker Linux arm64 镜像构建及无 Docker socket 启动 | 构建通过；核心与许可文件存在；健康接口真实返回 503 `workspace_unavailable`，没有冒报就绪 |
| `git diff --check` | 通过 |

前端使用已安装的 Codex Node 24.19.0；该固定运行时没有 npm 可执行文件，因此通过 Node 直接执行脚本对应的 Vitest、TypeScript 和 Vite 入口。未修改主机包管理配置。首次未限制并发的前端尝试在机器争用下出现旧测试超时，已停止并保留日志；上表 948 项来自按仓库 SaaS 标准测试集合、限制并发后的完整成功运行。

后端定向检查覆盖个人密钥代理、固定知识修订、跨租户与原发起人授权、审批幂等、实际 artifact、100 KiB 完整参数及截断标志、模型调用预算、撤销和取消、不确定审批不重试。全量 race 在既有 lease/body-wait 测试的 Argon2 注册阶段达到 20 分钟总期限；超时前未见断言失败或 `DATA RACE`，但这不构成全量通过证据。此前知识基础阶段的 342 项分批检查属于较早代码快照，不替代本次内置执行变更后的全量检查。

同时保留一项未通过的既有 OpenAI worker 回归：取消场景通过；deadline/UTF-8 场景在正确返回 `DEADLINE_EXCEEDED` 后，提供商调用计数预期 1、实际 0，导致失败，后半段 UTF-8 断言未执行。2 秒期限在 SDK 启动完成前已用尽；不能因此把整个 worker 回归写为通过。

当前证据位置：

- `/tmp/awwo-native-web-tests.log`、`awwo-native-web-types-saas.log`、`awwo-native-web-types.log`、`awwo-native-web-build.log`、`awwo-native-web-static.log`：最终前端结果。
- `/tmp/awwo-native-web-tests-unbounded.log`、`awwo-native-web-tests-legacy.log`：前端首次高并发尝试和旧入口依赖失败。
- `.local/knowledge-evidence/backend-native-race.log`：本次全后端 20 分钟超时；`/tmp/awwo-native-backend-vet.log`：vet 无诊断。
- `/tmp/awwo-native-openmaus-worker-unit-tests.log`：普通 worker 套件；真实核心场景及后端定向 race 的输出保留在本轮工具记录，没有另造日志路径。
- `/tmp/awwo-native-openmaus-image.log`、`awwo-native-openmaus-image.id`、`awwo-native-openmaus-image-smoke.json`：镜像与无 Docker 就绪检查。
- `/tmp/awwo-native-openai-retry.log`：上述既有 OpenAI worker 未通过场景。
- `/tmp/awwo-native-computer-model-google.log`：Google 兼容修复后的共享模型代理 8 项测试及严格类型检查。

这些是本机本轮证据，不随源码发布，也不是持续有效的线上状态证明。

## 内置执行的真实核心与容器验收

核心固定为 OpenMausBot `104fd17b8f7767e71ba3cf40f27f9c6279b507bd`。显式集成测试启动该核心和真实 Docker 工作区；仅模型 HTTP 响应使用确定性 fixture，没有把执行命令、文件或 SHA 伪造为返回值。

| 场景 | 结果 |
| --- | --- |
| 审批后写入 HTML、实际执行测试命令、发布文件并核对 SHA、原生 `ask_user` 回答 | 通过 |
| 拒绝工具审批 | 通过，没有批准后执行 |
| DELETE 内部运行取消 | 通过，终态与清理完成 |
| SSE 客户端断开 | 通过，运行取消并清理 |
| 模型请求预算耗尽 | 通过，明确失败并清理 |
| 同一审批并发提交相同答复、完整 write 参数保真 | 后续定向正向回归通过 |

最终镜像验收使用 Linux arm64，tag 为 `awwo-openmaus:managed-qa`，SHA 为 `36f810bcc25868f0c90989d0ba95b8dcfa78c02b5bcb56c61fafee77e2bf16dd`。已包含最后一次审批标题修复，读回 `approvalTitle=awwo_workspace_exec`、参数不在标题中重复、原生问题保留。另读回 Node 26.3.0、Docker CLI 29.1.2、非 root 用户 1000、核心已安装、无 `enterprise/`、许可文件存在；不挂 Docker socket 时健康接口返回 HTTP 503，随后正常关闭并清理临时验收容器。这是本地镜像与启动边界验收，没有发布或生产部署。

这一层证明固定核心能使用受限工作区工具，不证明真实模型的规划质量，也不证明宿主桌面控制。Docker、内部令牌和镜像由 AwwO 部署人员准备；最终用户在 AwwO「我的引擎」维护一套模型连接。

## 已完成的基础浏览器验证

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
| 旧版未配置外部桥接面板（前一阶段） | 显示“尚未配置桥接”，没有虚构 Bot 或取消请求误报；当前默认入口已替换为执行助手 |
| 弹窗键盘 Escape 关闭 | 关闭成功，恢复画布操作 |
| 最终四窗页面控制台 | 读取结果没有 error/warn 日志 |

截图在当前 worktree 的 `.local/knowledge-evidence/`，不包含账号秘密，也不作为源码提交：

- `four-previews.png`：同一画布中的四类实际渲染与交互结果。
- `knowledge-reviewed.png`：已发布知识、原件及引用图。

这些示例文件由浏览器本地生成，窗口明确标为“本地演示文件 · 非任务交付物”。本轮没有将它们描述成模型产出。

## 内置执行全栈与四产物浏览器验收

已在真实浏览器打开默认“执行助手”，确认面板正常渲染；无模型状态已改为中文“先选择执行模型”，入口指向 AwwO「我的引擎」，不要求另一套 OpenMaus 配置。

确定性本地模型提供方 → Pi raw 模型网关 → Go 模型租约 → 真实固定核心 → Docker → Go artifact 存储链路已通过。运行 `aaszN3tunC_BjA8BxcEDXU9Pn3O8RytU-` 的 5 次工具审批均由本轮验收人员在 CUA 浏览器中明确点击允许；运行完成后逐份读回实际字节并核对 SHA：

| 实际产物 | 字节数 | 状态 |
| --- | ---: | --- |
| `index.html` | 731 | 字节与 SHA 核对通过 |
| `model.obj` | 148 | 字节与 SHA 核对通过 |
| `report.pdf` | 807 | 字节与 SHA 核对通过 |
| `workspace.zip` | 1542 | 字节与 SHA 核对通过 |

证据：`.local/knowledge-evidence/native-full-stack-result.json`、`native-provider-calls.jsonl` 和 `/tmp/awwo-native-full-stack.log`。模型响应仍是确定性 fixture，这些文件通过真实工具执行和发布产生，不是画布“本地示例”按钮生成。

上述 4 个真实任务产物随后在浏览器完成四窗与归档闭环：

| 浏览器操作 | 实际读回 |
| --- | --- |
| 任务产物刷新 | 四种文件自动选中并实际渲染 |
| HTML 开启交互并点击按钮 | 页面显示“交互已验证 ✓” |
| OBJ 预览拖动 | 真实 WebGL 显示，拖动后视角变化 |
| PDF 预览 | 页码 1 / 1，实际 canvas 页面 |
| IDE ZIP 文件树 | `app.ts`、`index.html` 两文件可切换 |
| `index.html` 确认存为知识资料 | 画布状态显示“任务产物已保存为知识资料，可在知识地图中核对。” |
| 页面控制台 | `errors=[]` |

截图为 `.local/knowledge-evidence/native-four-previews.png`，使用浏览器默认 1280 × 720 视口，没有 viewport override。本节产物来自上述已完成的实际执行运行，与先前明确标记的本地示例区分。

恢复正常个人凭证模式并重启服务后的持久化读回已通过。确定性模型 fixture 已停止；`GET computer-runtime` 实际返回 `ready=false`、`models=[]`，界面正确显示“先选择执行模型”和“管理我的引擎”，没有继续把 fixture 当成用户已连接模型。已完成任务历史与 4 个实际产物仍在，刷新后四窗继续自动渲染；知识库保留 3 份资料，`index.html` v1 的 731 字节原文完整可见。持久化截图为 `.local/knowledge-evidence/native-knowledge-persisted.png`，四窗截图为 `native-four-previews.png`。

## 本地打开与恢复

本轮隔离实例使用 Web `5289`、API `8187`、PostgreSQL `55563`，与其他 checkout 的默认实例分开。

- 打开：`http://127.0.0.1:5289/?tenant=avKH7fYUAxytTi2ynTl8UJll8AvqNycO_&canvas=aW2d6AGxk5kBLbs8gERBMYHI_OV8XLwnn`
- 工作区：知识与交付物验收（本地）。画布：知识协作 · 四窗预览。
- 如需重新启动，在该 worktree 执行 `npm run dev:saas`。当前端口和本地初始化凭证保存在忽略文件 `.local/awwo-saas/.env`；不要提交或分享该文件。
- 本地文件预览存在浏览器内存中，刷新后需要重新选择文件或点击示例；知识库内容由数据库保留。

## 验收边界与剩余项

真实 OpenMaus 核心与 Docker 工作区已在上述显式场景及四产物全栈浏览器链路运行，恢复正常个人凭证模式并重启后的持久化读回也已通过。本轮仍未用真实提供商模型 API 验收推理质量；模型 fixture 是可复现的协议驱动。全后端竞态测试未完成，旧版 Web 测试缺独立依赖，既有 OpenAI deadline/UTF-8 回归未通过，这些限制仍保留。

产品仅承诺工作区命令、文件与发布工具，不包含宿主桌面、浏览器 GUI 或鼠标键盘控制。旧外部实例桥接的真实连接不是默认内置助手的前置条件，仍只作为高级 API 兼容保留。

预览中的 IDE 是只读文件树与源码窗口，不是完整终端 IDE。PDF/3D 预览不自动做 OCR、语义提取或资料入库。上述能力与界面中的实际支持范围一致。


## 2026-10-02 merged release and isolated provider acceptance

The final application source is `a16098b365c78f63e4a87c4d6e64db4772ec8bac`. The merged frontend passed 100 files / 1380 tests and both strict TypeScript configurations. The complete backend race suite passed 354 top-level tests and 342 subtests, with no skips or reported races; `go vet` passed. Pi passed 53 tests; OpenAI Agents passed 177 with 9 explicit baseline skips. These new results resolve the earlier timeout/worker deadline evidence gaps without changing their historical record.

[SaaS CI 36963830059](https://github.com/Clawhunt-Site/AwwO/actions/runs/36963830059) passed all six jobs, including actual Linux amd64 OpenMaus/Docker execution and a complete native archive. Use second-attempt artifact ID `11208339294`; the first same-name artifact lacked the intended public navigation URL and was rejected. Archive SHA256 is `cbbc4d7e93a13575e21f813fc7ffc0c7a38dcdd967f6dddbfbe6ce289f6a397a`, with `publicClawHuntURL=https://clawhunt.store/`.

The explicitly authorized built-in migrator was rehearsed against a stopped, consistent production backup restored on a separate PostgreSQL port. Candidate initialization and old-API startup passed. One isolated real-provider task then reused the existing default operator model through the AwwO model lease: three model invocations completed the approved write, publication and archive flow. The resulting HTML (203 bytes) and ZIP (263 bytes) matched their download hashes, the ZIP contained the expected HTML, and knowledge ingestion preserved its content. No provider credentials were given to OpenMaus or its workspace. The old API subsequently read the new synthetic session, canvas and both exact artifact bytes with the existing synthetic login cookie. Owned child processes and workspaces were cleaned up without errors. This test used the restored copy and did not create production test data.

Production promotion and browser readback are complete; see the [release record](awwo-managed-execution-release-20261002.md). The production browser used existing deterministic real-core output files locally for the four-format preview check, while the separate restored-copy test proved actual paid-provider execution. No synthetic task or knowledge data was written to the production tenant.
