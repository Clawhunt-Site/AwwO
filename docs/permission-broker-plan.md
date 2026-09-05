# （已废弃）权限 Broker 大设计

> 此文档描述的 Broker + taxonomy + ApprovalCoordinator 大设计**已被用户 descope 推翻**（2026-06-09），
> 判定为过度设计。
>
> **权威方案见 → [`permission-mode-framework.md`](./permission-mode-framework.md)**：
> 权限模式 = `Ask` / `Allow` 两态，纯传递映射到各 Agent Runtime 自带模式；每个 backend
> 必须声明 `permission_presets()` 映射（强制扩展点，一致性测试守门）。
>
> 保留此文件仅为历史/"考虑过但否决"的记录。
