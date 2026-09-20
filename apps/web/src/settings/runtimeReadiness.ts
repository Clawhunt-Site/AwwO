type Runtime = { available: boolean; readiness?: string; reason?: string | null };

export function runtimeReadiness(agent: Runtime | null | undefined, locale: string) {
  const zh = locale.startsWith('zh');
  if (!agent) return { label: zh ? '请选择 Agent' : 'Choose an agent', detail: zh ? '请选择要使用的本地 Agent。' : 'Choose a local agent to use.' };
  if (agent.readiness === 'installed') return {
    label: zh ? '已安装 · 待验证' : 'Installed · unverified',
    detail: zh ? '已检测到本地 CLI；登录状态和执行能力尚未验证。' : 'Local CLI detected; authentication and execution have not been verified.',
  };
  if (agent.readiness === 'disabled') return { label: zh ? '未启用' : 'Disabled', detail: zh ? '此运行时未启用。' : 'This runtime is disabled.' };
  if (agent.readiness === 'missing' || (!agent.readiness && !agent.available)) return {
    label: zh ? '未安装' : 'Not installed', detail: agent.reason || (zh ? '未找到本地 CLI，请安装后重新检测。' : 'Local CLI not found. Install it and recheck.'),
  };
  return { label: zh ? '待验证' : 'Unverified', detail: agent.reason || (zh ? '已注册适配器，尚未验证实际运行能力。' : 'Adapter registered; execution has not been verified.') };
}
