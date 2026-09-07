# AwwO Linux Codex sandbox：Ubuntu 24.04 按可执行文件授权

2026-09-06 已在独立 AWS 验收机完成无模型请求的实际验证：Codex 的工作区内文件可写、同一用户拥有的工作区外目录不可写。修复只为 Codex 自带的、由 root 管理的 `bwrap` 添加准确路径的 AppArmor user namespace 许可；全局限制保持开启。

## 适用版本与根因

本次实测版本：

| 项目 | 实测值 |
| --- | --- |
| 系统 | Ubuntu 24.04.4 LTS，x86_64 |
| 内核 | `7.0.0-1012-aws` |
| AppArmor 包 | `4.0.1really4.0.1-0ubuntu0.24.04.7` |
| AppArmor parser | `4.0.1` |
| Codex CLI | `0.153.3` |
| runtime 用户 | `awwo`，UID/GID `1001` |

故障发生在原生 sandbox 创建阶段，错误是 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`。主机保留 `kernel.apparmor_restrict_unprivileged_userns=1` 和 `kernel.unprivileged_userns_clone=1`；现有 `unprivileged_userns` profile 明确 `audit deny capability`，会拒绝命名空间中的额外 capability。

Ubuntu 24.04 官方发行说明提供了 `flags=(unconfined)` 加 `userns,` 的按应用 profile 方案，供创建自身 sandbox 的程序使用。它使指定程序能够建立 user namespace；文件系统和进程隔离仍由应用的 sandbox 实施。本机已安装的 `chrome`、`flatpak`、`linux-sandbox` profiles 也使用这个结构。[Ubuntu 24.04 发行说明](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890)、[Ubuntu AppArmor 文档](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)。

## 最小 profile

新增文件：`/etc/apparmor.d/awwo-codex-bwrap`。

```apparmor
# Ubuntu 24.04 user-namespace permission for the root-owned Codex sandbox helper.
# This is an executable-specific allowance; retain the host-wide userns restriction.
abi <abi/4.0>,
include <tunables/global>

profile awwo_codex_bwrap /opt/awwo-tools/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap flags=(unconfined) {
  userns,
}
```

安装前用 `namei -l` 检查完整可执行路径。本次 `bwrap` 及所有父目录均为 `root:root`，目录和程序权限均为 `0755`，runtime 用户不能替换它。规则没有通配符，不匹配其他 `bin`、其他安装位置或任意用户目录。

该规则按可执行文件匹配，适用于任何能够执行这一准确路径的普通调用者，程序仍以调用者身份运行；它不是按 Agent 或租户授权。当前服务器通过 SSH 限定操作员，不能将此规则解释为多租户隔离。

先把上述内容保存在受信任的候选文件中，只编译检查而不加载、不读写缓存：

```bash
sudo apparmor_parser -Q -K -b /etc/apparmor.d /path/to/candidate.apparmor
```

确认目标文件不存在后，由 root 创建，且不得允许普通用户修改。创建必须使用不覆盖既有文件的方式；若已存在，先检查不是符号链接，并逐字比对，遇到不同内容直接停止并保留既有文件。本次安装脚本用 `O_CREAT|O_EXCL` 和 mode `0644` 创建，经 umask `027` 限制后实际权限为 `0640`、所有者为 `root:root`；独立回读已核对。第二次发现相同内容后只比对保留。

只加载这个 profile，随后读回内核标签和全局开关：

```bash
sudo apparmor_parser -r -K /etc/apparmor.d/awwo-codex-bwrap
sudo grep -F 'awwo_codex_bwrap (' /sys/kernel/security/apparmor/profiles
sysctl kernel.apparmor_restrict_unprivileged_userns
```

实测返回 `awwo_codex_bwrap (unconfined)` 与 `kernel.apparmor_restrict_unprivileged_userns = 1`。没有禁用 AppArmor、修改全局 sysctl、加入宽泛 capability 规则或关闭 Codex sandbox。

## 当前 Codex CLI 的正确验证入口

`0.153.3` 的 Linux 入口是直接 `codex sandbox`，没有 `linux` 子命令。这个诊断子命令要求 `--permission-profile`；仅传旧的 `-c sandbox_mode="workspace-write"` 会在进入 sandbox 前返回 CLI exit `2`。

使用内置 `:workspace` profile：

```bash
sudo -u awwo /usr/local/bin/codex sandbox \
  -P :workspace \
  -C /absolute/new/workspace \
  -- /usr/local/bin/node /absolute/probe.mjs
```

无需写入新的 `config.toml` 或创建自定义权限 profile。`:workspace` 是 Codex 提供的工作区写入权限；权限 profiles 和旧 `sandbox_mode` 配置不应混合。本次诊断命令没有传旧 sandbox 设置，也没有修改现有 adapter 配置。[OpenAI Permissions 文档](https://developers.openai.com/codex/permissions/)。

## 正反验证及独立回读

验收根目录：`/srv/awwo/sandbox-acceptance.DaKhF94E`。目录中的 `workspace` 和 `outside` 分别由 `awwo` 拥有。测试先在 sandbox 外以同一用户成功写入 `outside/control.txt`，排除普通 Unix 目录权限造成假阴性，然后以 `-P :workspace -C .../workspace` 执行两次真实命令。

| 检查 | 结果 |
| --- | --- |
| sandbox 外写入同用户目录 `outside/control.txt` | 成功，读回 `AWWO-OUTSIDE-CONTROL` |
| sandbox 内写入 `workspace/inside.txt` | exit `0`，读回 `AWWO-SANDBOX-PROBE` |
| sandbox 内写入 `outside/denied.txt` | `EROFS`；探针按预期返回 exit `73`，文件不存在 |
| sandbox 子进程 UID/GID | `1001`，没有升级为宿主 root |
| `/proc/self/status` | `NoNewPrivs: 1`、`Seccomp: 2` |
| `/proc/self/attr/current` | `awwo_codex_bwrap (unconfined)` |
| 全局 userns 限制 | 仍为 `1` |

`result.json` 记录真实子命令退出码、errno、文件回读、进程约束和已加载规则。完成后又进行一次独立只读核对：断言 `passed=true`、inside exit `0`、outside exit `73`、工作区内文件内容、工作区外文件不存在、profile 哈希和 sysctl 值；该回读命令 exit `0`。

第一轮命令因缺少 `-P` 未进入 sandbox，记录保留在 `/srv/awwo/sandbox-acceptance.rJoDSCxI`。第二轮正反命令均得到上表结果；Windows PowerShell 向 SSH 标准输入附加的末尾 CR 导致外层 shell 随后 exit `127`。这不改变已保存的两次原生命令结果；独立回读已确认通过。辅助 shell 现显式 `exit 0`，避免读取追加的空 CR 行，未为消除包装层错误重复执行测试。

证据路径：

- 服务器：`/srv/awwo/sandbox-acceptance.DaKhF94E/result.json`，以及 `inside.json`、`outside.json`、`outside-control.json`、两个 stderr 文件和两个真实检查点文件。
- 本地忽略目录：`.local/server-acceptance/sandbox-profile-readback.json`、`sandbox-profile-probe-final.log`。
- 本地复现辅助：`.local/server-acceptance/install-sandbox-profile-and-probe.sh`、`awwo-codex-bwrap.apparmor`。这些文件是本次验收辅助，未纳入产品运行路径。

固定 SHA-256：

```text
AppArmor profile a52d46eb985e47cb8f049d0efec4816b386d1793469d89ed86778675b532d94e
Codex bwrap      77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c
```

## 验证边界

本次证明当前安装的 Codex 原生 sandbox 能建立、工作区内可写且同用户工作区外写入受阻；它不等同于模型认证、额度或完整 Agent 画布执行验收。没有发起模型请求、复制认证文件、消费额度重置或测试外部服务。

Codex 升级、安装目录或 CPU 架构变化后，需重新核对真实 `bwrap` 路径、root 所有权、profile attachment 和同样的正反 probe。不能为了覆盖新版本而扩大规则为任意目录通配符。该命名 profile 的 `unconfined` 不是额外的文件访问过滤器；工作区边界证据来自 Codex 实际施加的 sandbox，因此必须保留 `workspace-write` 或内置 `:workspace` 权限设置。
