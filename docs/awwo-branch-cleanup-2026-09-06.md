# AwwO 分支收敛记录 — 2026-09-06

操作者要求：本地和线上只保留 `main`、`online`，删除其余分支。

## 当前结果

**已于 2026-09-07 完成：本地和 Forgejo 均只保留 `main`、`online`，实际 Git HEAD 与 REST 默认分支均为 `main`。** 9 月 6 日的空仓标记异常及部分完成记录保留在下文，未覆盖原失败证据。

| 位置 | 当前 heads | 提交 |
| --- | --- | --- |
| 本地 AwwO | `main`、`online` | 均为 `6e1dc158a79e2f18c7bdf82610a353883b883f31` |
| Forgejo AwwO | `main`、`online` | 均为同一提交，`dev` 已删除 |
| Forgejo REST 默认分支 | `main` | 已写入并读回 |
| 实际 Git advertised HEAD | `refs/heads/main` | 与 REST 默认分支一致 |
| Forgejo REST 空仓标记 | `empty:false` | 已读回 |

操作范围仅为 `https://git.clawhunt.store/ClawHunt-Store/AwwO.git`，repo ID 218。当前旧 SuperClaw checkout 使用另一个远端，本轮未改变其任何 ref、工作文件或工作树。

## 已完成的操作

1. 实时 fetch、读取本地 heads、远端 heads、默认分支、工作树、仓库权限和保护。没有仓库级 webhook；继承 workflow 的 main push 跑 CI，未发现部署 job。版本 tag 才触发桌面打包，本轮没有推送任何 tag。
2. 本地三个原分支均指向 v0.3.0 的 `6e1dc15`；远端旧 v0.2.0 分支在其祖先上，没有需要丢弃的独有提交。
3. 创建并成功 `git bundle verify` 验证恢复包，保存清理前 ref 清单和工作树文件内容哈希。
4. 核验远端原有注解标签的 peeled commits：`v0.2.0` 对应 `22e5089360c230fcf8fba4d7ecadce5f7d7f62d1`，`v0.3.0` 对应 `6e1dc158a79e2f18c7bdf82610a353883b883f31`。未改标签。
5. 创建本地/远端 `main`、`online`，均保持已提交 v0.3.0 的完整 SHA；Forgejo 默认分支元数据改为 `main`。
6. 本地删除 `codex/awwo-v0.2.0`、`codex/accounts-i18n-state`、`codex/server-acceptance`，使用期望 SHA 比较保护删除。
7. 9 月 6 日，远端通过原子 push 和精确 SHA lease 删除 `codex/awwo-v0.2.0`、`codex/accounts-i18n-state`。当时 `dev` 删除被 Git 默认分支保护拒绝；没有关闭该保护。
8. 更新 `main`、`online` 的 upstream 和本地 `origin/HEAD`，prune 已删除的远端跟踪分支。
9. 9 月 7 日复查发现 `empty:false`，主任务随后完成实际 Git 默认 HEAD 切换及剩余 `dev` 清理；最终读回见下节。

## 9 月 7 日完成证据

北京时间 2026-09-07 00:48:59 的只读复查先确认 repo ID 218 已为 `empty:false`、`default_branch:main`；当时 Git advertised HEAD 仍为 `dev`，因此没有将空标记恢复当作清理完成。

随后主任务完成剩余操作，最终回执保存在主仓 `E:/Bobo's Coding cache/bo-work/AwwO/.git/cleanup-20260906/after-complete.json`。该回执的 `status` 为 `complete`，并明确记录：

- `local_heads` 与 `remote_heads` 都恰好包含 `refs/heads/main`、`refs/heads/online`。
- 两边的两个分支 SHA 均为 `6e1dc158a79e2f18c7bdf82610a353883b883f31`。
- `advertised_HEAD` 为 `ref: refs/heads/main`，HEAD 提交保持同一 SHA。
- REST 为 `empty:false`、`default_branch:main`。

此结论依据最终回执；原 `after-partial.json` 继续保留，记录 9 月 6 日确实发生的失败与部分完成状态。本次文档更新不执行任何 Git ref、服务器或业务文件操作。

## 工作目录与数据保留

| 目录 | 当前状态 |
| --- | --- |
| `E:/Bobo's Coding cache/bo-work/AwwO` | `main`，原文件不变 |
| `E:/Bobo's Coding cache/bo-work/AwwO-worktrees/accounts-i18n-state` | `online`，原文件不变 |
| `E:/Bobo's Coding cache/bo-work/AwwO-worktrees/server-acceptance` | 同一 SHA 的 detached HEAD，保留全部未提交验收内容 |

分支切换/删除前后，原有 56 个修改或未跟踪文件的 SHA-256 与状态清单完全一致（39 个已跟踪修改、17 个未跟踪文件）。没有删除工作目录、重置、清理或暂存用户内容。

此后本轮另行新增付费评测与本记录，并在隔离验收目录的 AGENTS.md、CLAUDE.md、coordination.md、docs/awwo-repository.md 中说明操作者的两分支新规则。这些说明尚未提交或推送，未夹带业务代码发布。

恢复资料位于主仓 Git 元数据目录：

- `.git/cleanup-20260906/before-cleanup.bundle`：完整已提交历史与清理前 refs，约 197 MB，已验证。
- `.git/cleanup-20260906/before.json`：原 ref、原有标签和各工作树文件哈希。
- `.git/cleanup-20260906/after-partial.json`：已完成部分的实际 readback。
- `.git/cleanup-20260906/after-complete.json`：9 月 7 日全部完成的最终 readback。
- `.git/awwo-branch-cleanup-20260906.py`：本轮操作脚本，不含凭据；恢复/续做前需重新读取实际状态，不能盲目重复阶段。

原始 bundle 不含未提交工作；未提交内容保留在原工作目录，前后哈希证明未被清理操作修改。需要恢复旧分支时，可用恢复记录中的 SHA 或原有版本标签重建；该动作会重新产生额外分支，只有需要恢复时再执行。

## 9 月 6 日最后一个 dev 被阻断的原因（已解决）

本仓库原有 `empty:true` 异常已记录在 `docs/awwo-v0.3-validation.md:89`。9 月 6 日复现：Git 有全部实际提交和 refs，REST 却返回空仓库，branches API 返回空值。

Forgejo v15.0.5 在 IsEmpty=true 时只写默认分支数据库字段，跳过 Git HEAD 更新。因此 PATCH main 成功不代表 bare Git HEAD 已切换。实际删除时返回：`refusing to delete the current branch: refs/heads/dev`。

按同版本官方源码核查，最窄的官方修复入口是**用正式登录的 Forgejo 网页会话打开这个仓库首页**：Home 发现实际 Git 仓库非空后会更新当前仓库的空标记和大小。当时本地 Git 凭证可认证 API，但普通首页明确不接受该 Basic/Token 认证；9 月 6 日浏览器无 Forgejo 登录会话，网页访问为 404。未把令牌放 URL、未改变私有性、未绕过网页认证。

本地 SSH 配置及有界的已配置 AWS 区域只读核查未找到有确切证据归属 Forgejo 的运维连接；没有猜测服务器或登录验收主机尝试修复。

当时确定的官方修复路径（历史记录，当前无需重复执行）：

1. 通过有效网页会话访问 AwwO 首页，REST 读回 `empty:false`。
2. 当时 REST 默认已是 main，需要正式设置为仍存在的 dev，再设 main，让有变化的设置调用真正更新 Git HEAD。
3. `git ls-remote --symref origin HEAD` 必须读到 `ref: refs/heads/main`，并确认 main/online SHA 未变。
4. 重新核验 dev 的精确 SHA，再删除 dev；fetch/prune，确认本地和远端 heads 恰好两个，标签和原有工作文件保持不变。

没有有效网页会话时，应由有权管理该 Forgejo 主机的人员仅检查 ID 218 对应裸仓及元数据。不要为了删除分支关闭 `receive.denyDeleteCurrent`，也不要运行全站 doctor/cron、改全站 hooks 或创建试探性提交。

参考固定版本源码：[默认分支 API](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.5/routers/api/v1/repo/repo.go#L817-L825)、[单仓首页自修复](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.5/routers/web/repo/view.go#L985-L1023)、[网页 Basic 认证边界](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.5/services/auth/method/basic.go#L41-L45)。

## 发布边界

`main` 和 `online` 的建立没有改变代码树，也没有部署服务。服务器 acceptance.5 的原有增量仍未提交；本轮没有用分支命名来把验收版本冒充生产版本。原有提交/发布审查要求保留。
