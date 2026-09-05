# AwwO · 真实 Codex 运行验证

本次使用当前电脑已经登录的 Codex 和原生 CLI 0.153.1，绑定了七个真实 Agent。每个节点拥有独立工作目录与 Session。七个节点全部实际执行成功，十二条连线的下游输入与对应上游输出逐项匹配。

- [打开 Agent 画布](http://localhost:5188/)
- [打开实际生成的知识库演示](http://127.0.0.1:4173/)
- [完整开发交接记录](2026-09-04-awwo-handoff.md)

## 已验证的流程

| 项目 | 实际结果 |
| --- | --- |
| Agent 绑定 | 七个 `codex_local` Agent，独立工作目录，复用本机现有登录 |
| 需求与架构 | 产出产品范围、架构边界及后续分工 |
| 节点交付 | 数据模型、权限规则、后端接口契约、前端演示、物料和验收报告 |
| 完整画布 | 7/7 真实运行成功，输出字段符合各节点表单契约 |
| 数据连接 | 12/12 实际下游输入与上游指定字段完全匹配 |
| Session | 新 Session 使用独立事项；已有 Session 可真实恢复 |
| 返工 | Codex 修复 Unicode 检索、标签恢复后的治理状态及弹窗 Tab 焦点问题 |
| 依赖恢复 | 浏览器复核完成后，系统自动恢复原验收事项，原 Codex Session 不变 |

原图的七次运行与十二条数据传递记录已冻结。后续修复和复验单独留证，没有重复计入首轮成绩。

最终复验运行 `cb0e4332-1797-4bb1-8545-18ced4772991` 已成功，AWW-12 已完成。它恢复并保持了原 Codex Session，返回了有效的 report / issues / verification 三个字段。最终回读没有仍在运行的 Agent 或待触发 monitor；前端事项 AWW-8 对真实服务接入的范围仍明确保留为 blocked。

## 检查与证据

- [原图运行及输入匹配](evidence/2026-09-04-awwo/codex-live-inputs.json)
- [首轮完成截图](evidence/2026-09-04-awwo/codex-live-completed.png)
- [两项业务演示返工](evidence/2026-09-04-awwo/codex-live-rework.json)：31 项模型/回归、3 组 DOM 测试通过。
- [真实浏览器检查记录](evidence/2026-09-04-awwo/codex-prototype-browser.md)：演示登录、检索、详情、工作区切换、角色菜单、看板、草稿保存和无效发布拦截。
- [浏览器复查快照](evidence/2026-09-04-awwo/aww-11-browser-passed-20260904T161819Z/snapshot-manifest.json)：原脚本 14/14，通过 320/375/768/1440 的实际应用检查；旧模块与修复模块的对照验证焦点问题已修复。
- [原 Session 复验记录](evidence/2026-09-04-awwo/codex-live-revalidation.json)：记录实际 run、Session 前后对照、依赖状态和最终字段。
- [验收 Agent 的最终报告](evidence/2026-09-04-awwo/codex-live-final-acceptance-20260905/reacceptance-20260905/acceptance-report-v2.md)：原报告及 57 份相关文件已独立保存，报告副本哈希匹配。

最终验收 Agent 再次执行并通过 31 项模型/Unicode 检查、4 项页面 DOM 检查及 8 项焦点检查。两项最初失败的业务复现均已关闭；另记录两处不阻断操作的排版观察。既有前端复核任务自动恢复并完成，新增的内部截图复核 AWW-18 也已完成，均未计入原图七次运行。

画布接入修复的针对性验证：绑定相关测试 40/40、紧凑卡片历史 20/20、交付物 26/26、网关 conversation 86/86。TypeScript、开发配置的前端构建和网关构建通过。未重复执行与本次改动无关的全量 CI。

## 范围与当前边界

这是本地真实 Agent 编排和生成交付物的验证。前端中的演示数据、演示登录有明确标记；真实身份服务、业务后端接入、完整无障碍验收与生产部署尚未完成。没有把接口契约或演示行为当作真实后端。

这次浏览器工具连接在后期发生本地路径错误，后续浏览器检查通过宿主现有 Playwright 执行。Agent 的 sandbox 保持启用，没有复制登录凭据或开放权限绕过。定时 heartbeat 关闭，依赖完成后的正常恢复保留。

画布仍保存首轮发布的交付表单。外部 API 续跑产生的复验记录不会自动替换已打开画布里的交付表单，因此后续结果在独立报告中提供。现有节点重新运行或明确采用手动输出时才会更新发布结果。

## 开发位置

- Worktree：`E:/Bobo's Coding cache/bo-work/superclaw/.worktrees/awwo-agent-canvas`
- 分支：`feat/awwo-agent-canvas`
- 基线：`feat/workflow-canvas-m1@c8db2818be40511bbb42ad5435028105a738e61c`
- 当前工作未提交；没有 push、PR、合并或部署。
- 共享 main 工作区原有 `CLAUDE.md` 修改已保留，vendor server 源码未改。

本次接入相关代码主要为 `apps/web/src/canvasHire.ts`、`canvas/SessionTile.tsx`、`canvas/NodeDeliverables.tsx` 及对应测试，和 `apps/gateway/src/conversation/{dispatcher,run-stream,stream}.ts` 及对应测试。前面的 AwwO 画布与模板改动保留在同一工作树，完整变更说明见交接记录。
