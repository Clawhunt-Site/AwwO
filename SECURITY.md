# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

**请不要用公开 issue 报告安全漏洞。** AwwO 处理用户的模型凭证、工作区数据和可执行的
agent 运行，公开披露会在修复前把用户置于风险中。

请改用 GitHub 的私密报告通道：本仓库 **Security → Report a vulnerability**
（[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)）。
它会创建一个只有维护者可见的草稿公告。

**Please do not open a public issue for a security vulnerability.** Use this
repository's **Security → Report a vulnerability** instead; it opens a draft
advisory visible only to the maintainers.

报告里请尽量包含：

- 受影响的组件（`backend/`、`apps/web`、某个 worker、`server/` 控制面……）与版本或 commit；
- 复现步骤，或一个最小复现；
- 实际影响（能读到什么、能写到什么、能以谁的身份执行什么）。

我们会在确认后答复，并在修复发布时在公告里致谢报告者（除非你希望匿名）。

## 范围 / Scope

本仓库是 AwwO 的源码。请只针对**你自己部署的实例**测试，不要对 ClawHunt 运营的线上服务做
扫描、压测或任何未经授权的测试。

This repository is AwwO's source. Please test only against **your own
deployment**; do not scan, load-test or otherwise probe the hosted service.

## 自行部署时的关键配置 / Hardening your own deployment

这几项配置错了会直接造成数据或凭证风险，部署前请逐条确认：

- **`AWWO_CREDENTIAL_ENCRYPTION_KEY`**：32 字节随机值，标准 base64。用户保存的模型 Key 用它
  加密（AES-256-GCM，绑定账号与连接 ID）。**它必须和数据库一起备份，升级或恢复时不要重新
  生成** —— 丢了就只能让所有用户重新填 Key。
- **`AWWO_CREDENTIAL_MODE`**：API 与所有 worker 必须一致。`user` 表示只用用户自己的凭证，
  个人模式下绝不回落到运营方的公共 Key。
- **环境文件放在 Git 之外**：用 `--env-file /secure/path/awwo.env`，不要把它提交进仓库。
- **只暴露入口**：ingress 默认绑回环地址，前面放 TLS 反向代理；数据库与 worker 不要对公网开放。
- **worker token**：每个 worker 一个独立的随机内部 token，不要复用。
- **`AWWO_PUBLIC_ORIGIN`** 必须是你真实的 HTTPS 源站，密码重置链接以它为准。

更多内容见 [个人账号与凭证部署](docs/personal-accounts.md) 与 [`deploy/saas`](deploy/saas)。

## 关于第三方代码 / Vendored code

`server/` 与 `third_party/` 下是 vendored 的上游项目（各自的 LICENSE 随代码保留，汇总见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。如果问题出在上游代码本身，请一并告诉我们，
我们会协助上报上游。
