# AwwO 内置执行与知识工作台：2026-10-02 发布记录

已上线 [AwwO](https://awwo.clawhunt.store)。API、网页、Pi、OpenAI Agents 与 OpenMaus 执行服务使用应用版本 `a16098b365c78f63e4a87c4d6e64db4772ec8bac`，维护门已解除。用户复用 AwwO 的模型配置，不需要另一套 OpenMaus 登录、配对或密钥。

## 交付与验证

- 知识来源、修订、关系图、提案审核、任务引用、产物归档与执行历史已集成。
- 正式站浏览器显示 HTML、3D、PDF、IDE 四窗，并通过 HTML 点击、3D 拖动/重置、PDF 页数与缩放、ZIP 源码切换检查。知识库读取成功，执行助手显示就绪和既有 Pi/OpenAI 模型。
- 四窗验收在正式站加载已有确定性模型集成产物，仅作本地预览；没有向用户生产画布写入测试任务或知识数据。独立的真实提供商任务在恢复副本上执行，3 次模型调用完成审批、HTML/ZIP 交付及知识入库；旧 API 还能读取这些新会话和产物。
- [SaaS CI](https://github.com/Clawhunt-Site/AwwO/actions/runs/36963830059) 的六项检查全部通过；[通用 CI](https://github.com/Clawhunt-Site/AwwO/actions/runs/36963830024) 的 Linux/Windows 检查也通过。完整测试数量与边界见 [功能验收记录](knowledge-workbench-acceptance.md)。

公网经既有 Cloudflare Access 鉴权读回，与原点均返回上述完整 SHA。网页 HTML、入口 JS 和 CSS 字节与不可变归档一致，三个相关 worker 均真实 ready。原 operator 模式、凭证库加密密钥和 SSO 配置保持一致；独立 TypeSafe root 与原有 Python worker 保留。

## 不可变产物

| 项目 | 验证值 |
| --- | --- |
| GitHub artifact | 第二次打包 `11208339294`，Linux amd64 |
| 归档 SHA256 | `cbbc4d7e93a13575e21f813fc7ffc0c7a38dcdd967f6dddbfbe6ce289f6a397a` |
| Workspace image ID | `sha256:b9ad58f67aa0940b4ede279f2ac24a2c3fc0f29aacbda90a20dda3c016870452` |
| OpenMaus upstream | `104fd17b8f7767e71ba3cf40f27f9c6279b507bd`，patch version 1 |
| Public ClawHunt URL | `https://clawhunt.store/` |
| API/web/model source | `/srv/awwo/releases/saas-a16098b365c7` |
| Managed broker | `127.0.0.1:8109`，专用 `awwo-openmaus` 账号 |
| PostgreSQL | 生产 `55483`；恢复副本 `55439` |

同名 artifact 的第一次产物没有预期的 ClawHunt URL，未部署。下载应按上述 artifact ID，而不是取名称匹配的首个结果。

## 数据恢复与回退

用户明确允许本次采用内置迁移器。发布前暂停新任务，连续三次确认活跃任务为零，再正常停止 API/PostgreSQL，生成含凭证库恢复材料的一致性冷备；归档持久化后立即恢复原服务。随后在隔离副本执行候选迁移，并验证旧 API 启动和认证后的业务读取兼容。

- 冷备 SHA256：`52cc621abc1ce5d0e0e00da7daac8aff9ad652f2263ea47653539ea5aa7cd988`。
- 主机私有证据目录：`/srv/awwo/saas-staging/backups/managed-release-a16098b365c78f63e4a87c4d6e64db4772ec8bac`，包含 backup manifest、恢复证明、迁移证明、公网读回及最终状态。
- 成功切换的配置回退目录：`/srv/awwo/saas-staging/backups/managed-switch-20261002T044354Z-a16098b365c7-e31ae6`。
- 旧 API/web 版本：`d278b7628c5d846ca2f515affc9165086368f32a`；旧模型 worker source 为 `saas-03b72b2e9190`，各自原 Node 路径和完整配置保存在回退清单。

EBS 快照请求仅作为补充；当前权限无法读回其完成状态，因此未将它计作已验证恢复点。恢复保障来自实际通过恢复演练的一致性冷备。回退须先暂停并排空新旧执行任务，再使用记录的配置；保留新增表和数据，不执行破坏性数据库回滚。此验证不能代替任意未来版本或所有业务路径的降级验证。

## 现场修正与验收边界

1. 新 Docker 29 的镜像存储表示与 CI config image ID 不同。在新 daemon 无容器时改用 overlay2，重新导入归档并核对精确 image ID。镜像和运行配置均保持隔离，API 账号未获得 Docker 权限。
2. 8099 已被原有 Python worker 使用。首次切换在新 broker 就绪门处自动回退，旧版本与入口恢复后，将新 broker 改为 8109，并增加两次真实空闲端口检查；第二次切换成功。
3. 正式站的旧 nginx MIME 表把 PDF.js `.mjs` worker 返回为 `application/octet-stream`。已备份并补充 JavaScript 映射，保留 `nosniff`，reload 后公网类型与浏览器 PDF 渲染均通过。应用归档字节未改变；容器 nginx 模板同步修复并通过真实 HTTP 冒烟，包含缺失模块的 404 检查。

本地证据保存在 `.local/knowledge-evidence/production-four-previews.jpg`、`production-executor-ready.jpg`、`production-knowledge-ready.jpg`、`production-browser-acceptance.json` 和 `nginx-mjs-smoke-20261002.json`。浏览器插件自身的控制台错误与应用证据分开记录；首次 PDF 警告保留为已修复的历史记录。

本次收尾改动仅包含部署配置与记录。推送记录时，GitHub main 已有并行的 macOS 邀请和画布规划恢复提交；它们会在正常快进推送中保留，未被混入本次已验收的不可变归档。正式运行的 Go/Web/worker 应用版本仍以上述 SHA 为准。凭证、原始数据库、私有环境和恢复材料不进入 Git。
