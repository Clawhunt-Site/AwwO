# AwwO Computer Use 验收覆盖

本表对应本轮 40 项复合场景，以真实 GUI 观察为依据，不以组件测试代替点击、刷新或下载验收。工作树与版本范围见[验收报告](awwo-computer-use-acceptance-20260907.md)。截至 2026-09-07 17:47:03（Asia/Shanghai），共 369 条观察；其中 4 项核心 GUI 场景通过、34 项部分覆盖、2 项未执行。部分覆盖通常表示主要操作已成功，但同项的异常、权限或持久化分支尚未逐一执行。表内 label 对应本地 `computer-use-observations.json`，不包含账号凭据或邀请 token。

| ID | 状态 | 已观察结果（证据 label） | 剩余分支／限制 |
|---|---|---|---|
| U01 | 部分 | 注册、退出重登、错误密码及重复邮箱中英提示：`owner-registration-result`、`login-fixed-zh`、`login-fixed-en`、`duplicate-email-zh`、`duplicate-email-en` | 无效邮箱原生提示未取得明确 AX 证据；空白／短密码未测 |
| U02 | 部分 | 多租户切换、私人图隔离、跨租户页面拒绝：`reader-private-created`、`owner-cross-tenant-denied` | 跨租户未同步草稿和会话缓存往返未测 |
| U03 | 部分 | 平台管理员可进管理端；暂停租户可切换退出：`platform-admin-home`、`paused-reader-escape` | 普通零租户及管理员零租户默认首页未单独测 |
| U04 | 部分 | EN／浅色刷新保留、登录错误即时切语言：`theme-locale-persisted`、`login-fixed-en` | 未对每个面板逐一组合中英及深浅主题 |
| U05 | 部分 | 原账户面板改名，重登后保留：`profile-saved`、`owner-member-management` | 空白姓名与保存失败保留输入未测 |
| U06 | 部分 | owner 增改删成员、取消移除、移除后拒绝访问、未知邮箱拒绝：`member-readded`、`member-removed`、`unknown-member-rejected` | 普通 member 管理限制及三种角色逐个添加未测 |
| U07 | 部分 | tenant admin 无法改 owner/admin、无法授 admin、不能进平台端：`tenant-admin-protected-roles`、`tenant-admin-assign-options` | tenant admin 实际增改删 reader/member 未测 |
| U08 | 部分 | 邀请复制后注册、显式确认领取、已有账号领取：`invite-before-auth`、`invite-claim-review`、`reader-invite-accepted` | 暂不加入、剪贴板失败未测 |
| U09 | 通过 | 撤销状态持久、撤销链接拒绝、其他人领已用链接拒绝：`invite-revoked-list`、`revoked-invite-denied`、`used-invite-other-owner-denied` | GUI 不单独证明 API 错误码或零成员写入 |
| U10 | 部分 | 已有 reader 不因 admin 邀请升权、移除后旧链接不能恢复成员：`reader-no-elevation`、`removed-member-old-invite-denied` | 未移除状态下同人重复领取同 token 的幂等分支未测 |
| U11 | 部分 | 无效邀请给明确提示且可返回：`invalid-invite-denied` | 过期、发行者失权、暂停租户邀请未测 |
| U12 | 部分 | 重开账户面板只显示邀请元数据及撤销状态：`owner-member-management`、`tenant-admin-protected-roles` | 有效邀请关闭重开后撤销的完整顺序未单独测 |
| C01 | 部分 | 空图、空白 Agent、产品研发模板5节点5连接，刷新保留：`blank-agent-added`、`template-product-count`、`template-refresh-five` | 模板库逐个预览、空名称拒绝未测 |
| C02 | 通过 | 合法计划直接生成2节点1连接；配置绑定后首次整图完成2/2：`planner-result`、`b-config-saved`、`graph-two-of-two` | 仅本地协议 fixture，不代表真实模型规划质量 |
| C03 | 部分 | 已有5/5图规划后7/6，撤销回5/5；同base假草稿修后明确恢复并连续两次刷新仍5/5已同步：`planner-existing-seven`、`planner-undo-five`、`equality-fixed-refresh`、`equality-fixed-second-refresh` | 无效plan、循环／类型冲突、运行或绑定期间的写锁未测 |
| C04 | 部分 | 慢规划取消，等候及刷新仍0/0：`planner-cancelled-empty`、`planner-cancel-reloaded` | 未配置实例、断连、无效输出未测；后台终止需独立服务证据 |
| C05 | 部分 | 选择Pi，异步模型目录出现，默认模型绑定持久：`b-runtime-selected`、`b-bound`、`fork-old-config` | 显式选模型及不可用模型未测 |
| C06 | 部分 | 改人格生成新Session、重新绑定新历史0/0、切旧Session保留旧人格和历史：`new-persona-completed`、`fork-old-config` | runtime/model/effort 等配置逐项分叉未测 |
| C07 | 部分 | 必填输出拒绝、编辑不发布、发布成功、改契约变历史：`manual-required-denied`、`manual-published`、`contract-rename-invalidates-output` | 增删字段、类型输入、多上游合并未测 |
| C08 | 部分 | 单击保留线、双击删除、实际拖线、撤销重做、刷新保留：`wire-single-click-preserved`、`wire-drag-reconnected`、`wire-reload-persisted` | 自连、不兼容线、循环阻断未测 |
| C09 | 部分 | 适配视图及连线撤销重做：`wire-fit`、`wire-undo-zero`、`wire-redo-drag` | 拖节点、自动排列、搜索、小地图、节点删除恢复未完整测 |
| C10 | 部分 | 已保存图重载、导出下载完成：`wire-reload-persisted`、`reader-export-canvas`、`audit-export` | 下载JSON未在GUI打开逐字段核对；规划撤销误报已修并两次刷新复验见C03 |
| R01 | 部分 | 新Session、历史刷新、取消后续发、另Session草稿保留：`history-restored`、`after-cancel-complete`、`other-session-draft-retained` | 历史读取失败未测 |
| R02 | 通过 | A→B顺序运行，B可见A结果，完成2/2：`graph-two-of-two`、`b-deliverables` | provider请求计数和输入精确传递另用协议证据；非真实外部模型 |
| R03 | 部分 | 未绑定预检提示、正常绑定后可运行：`unbound-preflight`、`b-bound` | 同一未绑定图补绑定再跑、坏结构化输出阻断未测 |
| R04 | 部分 | 局部B正向1/1沿用上游；缺产出阻断计数修后1/1且保留A/B原因：`scoped-positive-completed`、`scope-fixed-negative-pass` | 坏字段类型分支未测；零dispatch另查协议 |
| R05 | 部分 | 慢运行刷新恢复，修后已发送草稿清空、另一草稿保留：`draft-fixed-empty-after-refresh`、`other-session-draft-retained` | 恢复读取失败未测；不重复run需独立计数 |
| R06 | 部分 | 停止hold，同Session立即再发成功：`hold-stop-result`、`after-cancel-complete` | 取消失败、重复停止、多节点取消分支未测 |
| R07 | 通过 | 真正闭页后恢复A结果、B仍未派发，冲突草稿+journal修后可安全进入核对：`offline-fixed-recovery-entry`、`offline-fixed-lock-after-wait`、`offline-fixed-a-history` | GUI1成功1阻断；闭页后台零B请求及输出hash另有Go证据 |
| R08 | 部分 | 结构化字段、历史交付、手动发布、契约变更失效：`reader-old-session-delivery`、`manual-published`、`contract-rename-invalidates-output` | 坏JSON／类型输出未测；手动聊天不自动发布交付物属现有语义 |
| R09 | 未执行 | 无文件路径／Markdown链接复制的操作证据 | 原画布无附件上传；file字段不证明文件创建或工具执行 |
| R10 | 部分 | 日额度拒绝，恢复额度后再次接收：`daily-quota-denied`、`hold-admin-send` | 未配置、断连、输入超限、不支持模型未测；额度运行错误仍为英文 |
| S01 | 部分 | 第二真实标签改图，旧页运行受保护拒绝，冲突刷新保留：`stale-tab-run-rejected`、`conflict-draft-survived-reload` | HTTP409及零dispatch由独立协议证据确认 |
| S02 | 部分 | 导出、刷新保留、取消丢弃、确认丢弃另份草稿；云端核对后旧base70和新base84备份都保留：`discard-cancel-kept`、`synthetic-draft-discarded`、`offline-fixed-original-draft-choice` | 相同base纯网络失败恢复、下载内容GUI核验未测 |
| S03 | 部分 | 原图、历史、交付可读；配置写入口禁用并可导出：`reader-config-locked`、`reader-old-session-delivery`、`reader-export-canvas` | 所有拖拽／写入口、缓存隔离和API403须独立验收 |
| A01 | 部分 | reader/admin租户角色拒绝平台端，平台管理员四类列表有内容：`tenant-admin-platform-denied`、`platform-admin-home`、`admin-users` | owner/member 直接平台URL拒绝未单独测 |
| A02 | 部分 | 0配额拒绝、改1/1、日额度生效、恢复额度：`quota-invalid-zero`、`quota-one-saved`、`daily-quota-denied` | 小数、上界、实际并发额度及逐项审计值未测 |
| A03 | 部分 | 暂停租户使活动run取消，reader可逃离；恢复后再跑成功：`admin-paused-run-list`、`paused-reader-escape`、`fixed-slow-send` | 暂停时已开owner画布的新写拒绝未单独测 |
| A04 | 部分 | 审计实际第二页、JSON下载完成：`audit-second-page`、`audit-export`、`admin-run-export` | GUI未打开下载内容；审计60条由独立DB/文件证据核对。其他分类50+条、上一页与刷新重置未逐一测 |
| A05 | 未执行 | 无导出取消、列表故障刷新或失效cursor GUI证据 | 普通导出完成不覆盖取消／失败 |

本轮使用隔离的本地确定性协议服务，证明原画布、Go API、Pi SDK 的可观察协议交互，不代表真实外部provider连通、模型效果或生产上线验收。Pi没有shell、文件写入或任意网络工具；页面关闭仅继续Go已接收的run，后续DAG节点仍由浏览器调度。管理员跨页导出不是同一数据库事务快照。自动化测试与本表分别报告，两套Web测试包含重叠用例，不能直接相加。
