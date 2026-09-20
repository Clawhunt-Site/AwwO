# AwwO

作者：[Boxpo](https://github.com/Boxpo)

AwwO 是一个协作式 AI 画布。登录账号后，选择执行引擎并连接自己的模型服务，把 Bot、角色和任务连成可以运行的工作流。

## 使用线上版与 Windows 版

- **线上版**：[awwo.clawhunt.store](https://awwo.clawhunt.store)。如站点启用了访问门禁，需要先通过门禁，再登录 AwwO 账号。
- **Windows 版**：轻量 WebView2 客户端，与线上版共用账号、工作区和执行服务。安装包通过 [GitHub Releases](https://github.com/Clawhunt-Site/AwwO/releases) 发布；构建方式见 [`apps/windows`](apps/windows/README.md)。需要 Windows 10/11 和网络连接。
- Windows 客户端不会另外创建本地数据库，也不会自动运行本机命令。原有本地执行客户端保留在 `apps/desktop`；新客户端以 **AwwO Cloud** 独立安装，保留旧版和数据。

### 首次登录

1. 用邮箱和密码注册或登录 AwwO。
2. 选择模型服务商和执行引擎，填写**自己的 API Key**。
3. 验证并保存连接，选择服务商返回的可用模型。
4. 在画布中添加模型和 Bot，提交对话或运行任务。

如需使用我们的模型服务，请先到 [LLM Gate](https://api.clawhunt.site/) 购买额度、创建个人凭证，再在 AwwO 中选择 **LLM Gate** 并填写该凭证。AwwO 不代购，也不会在个人凭证失效时改用平台公共 Key。

| 模型服务 | 可选执行引擎 |
| --- | --- |
| LLM Gate / ClawHunt | Pi、OpenAI Agents |
| OpenAI / Codex 模型 | OpenAI Agents |
| Claude / Anthropic | Pi |
| Grok / xAI | Pi、OpenAI Agents |
| Gemini / Google | Pi、OpenAI Agents |

这里的 Codex 指 API 提供的模型；ChatGPT 网页订阅或本机 Codex 登录不能代替 API Key。模型权限、余额及费用由对应服务商管理。验证模型目录成功不代表已完成付费推理或确认余额充足。

Key 在服务端加密存储，并绑定到个人账号。共享画布不会共享凭证；其他成员执行时需要选择自己的连接。账号设置支持资料修改、密码修改、连接删除和登录会话撤销。官方线上版已启用邮件找回密码；自行部署时需要管理员配置 SMTP。

## 本地启动完整服务

需要 Node.js 24 LTS、Go 1.27.1+、PostgreSQL 16+，以及 PATH 中的 `initdb`、`pg_ctl`、`psql`、`createdb`。

```sh
git clone https://github.com/Clawhunt-Site/AwwO.git
cd AwwO
npm run start:user
```

打开 `http://127.0.0.1:5189`。启动器会安装缺失依赖，并启动数据库、API、Web 和执行器；Ctrl-C 停止本次启动的服务。数据和私有配置保存在 `.local/awwo-saas`。端口占用时不会结束其他程序。Windows 开发建议在 WSL 中运行完整服务。

这会创建一个独立的服务实例，其账号和数据不与线上数据库自动同步。仅使用线上服务时，直接打开网页或安装 Windows 客户端即可。

## 部署与组成

生产部署配置位于 [`deploy/saas`](deploy/saas)。将示例环境变量复制到 Git 之外的安全位置，配置 HTTPS 地址、数据库密码、独立 worker token，以及稳定的 `AWWO_CREDENTIAL_ENCRYPTION_KEY`：

```sh
docker compose --env-file /secure/path/awwo.env -f deploy/saas/compose.yml up -d --build
```

密钥加密用的 vault key 必须随数据库一起备份，升级时不要重新生成。入口默认绑定回环地址供 TLS 反向代理使用，数据库与 worker 保持私有。所有 API 和执行器必须一致设置 `AWWO_CREDENTIAL_MODE=user`。

| 路径 | 用途 |
| --- | --- |
| `backend` | Go API、账号、工作区、持久化任务、凭证加密与授权 |
| `apps/web` 的 SaaS 构建 | 登录、个人引擎设置、协作画布 |
| `apps/pi-worker` | Pi 执行器 |
| `apps/openai-agents-worker` | OpenAI Agents JavaScript 执行器 |
| `apps/openai-agents-python-worker` | 同一 OpenAI Agents 接口的 Python 执行器实现 |
| `apps/windows` / `apps/macos` | 连接已部署服务的桌面客户端 |

个人模式的画布规划使用当前用户可用的引擎。旧 Jev 编排服务尚未支持个人凭证，个人模式会在服务端拒绝该入口；不能将旧代理直接接回使用平台 Key 的服务。完整配置、迁移和回滚说明见 [个人账号与凭证部署](docs/personal-accounts.md)。仓库中的历史文档不代表当前部署状态。

## 验证

```sh
npm run test:saas:backend
npm run test:user-models
npm run test:saas:pi
npm run test:saas:openai-agents
npm run test:saas:scripts
npm run test:saas --prefix apps/web
npm run typecheck:saas --prefix apps/web
npm run test:windows
npm run build:saas
```

后端测试必须使用可丢弃的数据库：启动器读取本地专用数据库或显式 `AWWO_DATABASE_URL`，直接运行 `go test` 时使用 `AWWO_TEST_DATABASE_URL`。Provider fixture 使用合成 Key，不购买额度；它们用于验证协议和隔离，不等同于真实付费模型验收。

## License

见 [LICENSE](LICENSE)。
