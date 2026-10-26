# 参与 AwwO / Contributing to AwwO

欢迎。AwwO 是一个协作式 AI 画布：Go API + PostgreSQL 做事实源，Web 画布做表层，
多个执行器（worker）把节点跑成真实的 agent 运行。

## 先跑起来

需要 Node.js 24 LTS、Go 1.27.1+、PostgreSQL 16+（`initdb`、`pg_ctl`、`psql`、`createdb` 在 PATH 上）。

```sh
npm run start:user
```

打开 `http://127.0.0.1:5189`。启动器会装缺失依赖、建一个独立的回环数据库、启动 API / Web /
执行器，数据与私有配置落在 `.local/awwo-saas`。Windows 上建议在 WSL 里跑完整服务。

只想要本地单人版（数据全在本机、用自己的模型 Key）：

```sh
npm run setup:local
npm run local
```

更多说明见 [AwwO 开发说明](docs/awwo-development.md)、[SaaS 开发说明](docs/awwo-saas-development.md)
与 [AwwO 本地版](docs/awwo-local-edition.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `backend/` | Go API：账号、工作区、运行、凭证加密与授权 |
| `apps/web/` | 浏览器端：登录、画布、设置 |
| `apps/pi-worker/`、`apps/openai-agents-worker/`、`apps/openai-agents-python-worker/`、`apps/openmaus-worker/`、`apps/render-worker/` | 各执行器 |
| `apps/desktop/`、`apps/macos/`、`apps/windows/`、`apps/windows-local/` | 桌面客户端与本地版打包 |
| `packages/` | 共享 Python 包（含正在退役的旧 CLI） |
| `skills/`、`examples/` | 技能定义与示例 |
| `docs/` | 架构、契约与产品文档 |
| `server/` | **vendored 上游**（Paperclip，MIT）—— 不要在本仓直接改 |
| `third_party/` | **vendored 上游**（各自 LICENSE，见 THIRD_PARTY_NOTICES.md）—— 不要在本仓直接改 |

`server/` 与 `third_party/` 是按前缀 vendored 进来的上游代码。属于上游的改动请提给上游项目；
只有把 AwwO 接上它们所必需的改动才落在这里，并在 PR 里说明为什么必须改在这一侧。

## 改动前

- **先读 [AwwO 的 laws](docs/laws/awwo-laws.md)。** 那是产品必须守住的可观测不变量，评审会逐条
  对照。新功能如果和某条冲突，先说清楚是功能要改还是 law 要改。
- **先搜再写。** 仓库里多数能力已有既成模式（契约、worker 协议、画布节点）。照已有的写，
  别另起一套。
- **契约只有一个源。** 跨表层共享的能力清单、控件规格与默认值由内核契约给出，前端不要硬编码
  任何 runtime 的模型名或档位 —— 加一个就要同步另一端，断一层就算 bug。

## 测试

跑和你改动相关的那几套，不必每次全量：

```sh
npm run test:saas:backend             # Go API（需要可丢弃的数据库）
npm test --prefix apps/web            # Web
npm run typecheck:saas --prefix apps/web
npm run test:saas:pi                  # Pi 执行器
npm run test:saas:openai-agents       # OpenAI Agents 执行器
npm run test:saas:scripts             # 启动器与脚本
npm run test:local                    # 本地版
python -m pytest                      # Python 包
ruff check packages apps              # Python lint
npm run check:hygiene                 # 源码卫生（控制字符、CRLF）
```

后端测试必须用可丢弃的数据库：启动器读本地专用库，或显式给 `AWWO_TEST_DATABASE_URL`。
Provider fixture 用的是合成 Key，不购买额度，也不代表真实付费模型验收。

提 PR 之前跑一遍完整相关套件，并在 PR 里贴结果。测试失败就说失败，别含糊。

## 提交与 PR

- 一个 commit 一件事，可独立 review、可独立回滚。
- 用约定式前缀：`feat(...)` / `fix(...)` / `refactor(...)` / `docs(...)` / `test(...)`。
- commit 正文写清楚**做了什么 + 为什么**，不只是改了哪里。
- 不要提交密钥、`.env`、真实凭证或任何生产主机标识。`.env.example` 里只放占位值。
- 功能改动配测试；只改文档的 commit 单独提。

## 安全

发现漏洞请不要开公开 issue，走 [SECURITY.md](SECURITY.md) 里的私密报告通道。

## 许可

提交到本仓库的代码按 [MIT](LICENSE) 授权。
