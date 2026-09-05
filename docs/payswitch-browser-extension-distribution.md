# PaySwitch 浏览器扩展分发方案

Status: 规划 + demo 临时方案（2026-06-08）

PaySwitch 插件需要一个 Chrome 扩展（PaySwitch Browser Relay）加载进用户的真实 Chrome
profile，扩展通过本地 relay（`127.0.0.1:8787`）与 payswitch sidecar 通信，从而在用户已登录、
有支付方式的 Chrome 里执行受管的浏览器操作。

本文记录：为什么不能"程序自动装"、demo 怎么手动装、以及未来正式的一键安装方案。

## 硬约束：不能静默/自动把 unpacked 扩展装进现有登录 profile

经 Codex 校验（本机 Chrome 149.0.7827.53）：

- **Chrome 137 起**：branded Google Chrome **移除了 `--load-extension`**——退出后带该 flag 重启
  Chrome 自动加载扩展的老路**在现版无效**。
- **Chrome 136 起**：禁止对**默认数据目录**使用 remote debugging——CDP/WebDriver BiDi 注入
  扩展（`Extensions.loadUnpacked` / `webExtension.install`）那条路对"现有 Default profile"也堵了。
- 同一 `user-data-dir` 只能被一个 Chrome 进程打开；`--load-extension` 仅在进程启动那刻生效。
- 托管策略 force-install（`ExtensionInstallForcelist`）在 macOS 需 MDM/MCX/Chrome Enterprise
  Core 等 managed 环境，且只能装 packed `.crx` + update manifest，不是 unpacked。

**结论：从 app 里"一键自动装进用户现有登录 Chrome"在 Chrome 149 安全模型下做不到。** 这是
浏览器层面的限制，不是实现问题。能自动的只有"打开指定 profile"（`open -a "Google Chrome"
--args --profile-directory=Default`），扩展的加载那一步 Chrome 强制要人工或走商店。

## Demo 临时方案：固定路径 + 手动 Load unpacked（一次性）

之前扩展从 `…/plugins/cache/…/browser_extension` 加载会 stale，根因是**插件重装时 cache 目录
被 rmtree 重建 → Chrome 加载的目录失效**。修法：把扩展拷到**不随重装变动的固定路径**。

固定路径（已就位）：
```
/Users/leongong/.superclaw/payswitch-extension
```

手动加载步骤（一次性，加载后持久保留在该 profile）：
1. Chrome 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式 / Developer mode**
3. 点 **加载已解压的扩展程序 / Load unpacked**，选上面那个固定目录
4. 打开 PaySwitch Relay 扩展弹窗
5. 回到 SuperClaw 插件配置 → 点 **Refresh Browser Relay** → 应变为 `connected: true`

排查：
- 若 `heartbeat stale / connected:false`：多半是 Chrome 关了、扩展被"停用开发者模式扩展"
  提示禁用了、或加载的目录失效——重新启用扩展或重新 Load 固定目录即可，不用重装插件。
- relay 服务（`127.0.0.1:8787`）需 app 运行/调用过 payswitch 才会起；`reachable:true` 表示
  relay 在跑，`connected:false` 表示当前没有扩展在心跳。

## 未来正式方案：Chrome Web Store（unlisted）→ 真·一键安装

这是 Chrome 唯一官方支持的一键安装路径，过审后体验即用户期望的"跳转商店页 → 添加到
Chrome → 装进登录 profile"，**Chrome 149 完全支持，无需开发者模式**。SuperClaw 安装插件时
只需打开扩展的商店 listing URL。

落地清单：
1. **开发者账号**：Chrome Web Store 开发者注册（$5 一次性）。
2. **可见性**：发成 **Unlisted（不公开）**——不被搜索发现、凭链接安装，不公开给大众；仍需过审。
3. **收窄权限以降低审核风险**（重要）：当前 manifest 申请了
   `host_permissions: ["<all_urls>", …]` + `scripting` + 支付自动化语义，这是商店审核的**最高
   风险组合**，会重点人工审、耗时数天、可能打回。建议把 `<all_urls>` **收窄到实际需要的支付
   站点域名白名单**，能显著降低审核时间与被拒概率。
4. **过审材料**：128px 图标、商店截图、详细描述、**隐私政策 URL**（高权限/数据访问必需）、
   权限用途说明。
5. **客户端接线**：把"安装扩展"按钮从"显示 Load unpacked 说明"改为"打开商店 listing URL"。

时间预期：新账号 + 高权限扩展，审核**数天起**，并可能有来回。**因此不适合赶 demo**，作为
demo 之后的正式路径推进。

## 与插件分发的关系

扩展文件已随 `.scplug` 一起分发（`browser_extension/` 在包内）。"插件安装"只把文件落到本地；
"扩展加载进 Chrome"是独立的一步（demo 手动 / 未来商店一键）。这两层解耦，互不影响。

相关：[[plugin-trust-chain-design]]（插件本体的签名/分发）。
