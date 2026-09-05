import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "./helpers.js";
import { resolveWorkflowSpec } from "./execute.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const envConfig = parseObject(ctx.config.env);
  const bindingKey = asString(envConfig.RUNNINGHUB_API_KEY).trim();
  const instanceKey = (process.env.RUNNINGHUB_API_KEY ?? "").trim();

  if (!bindingKey && !instanceKey) {
    checks.push({
      code: "runninghub_api_key_missing",
      level: "error",
      message: "RUNNINGHUB_API_KEY 未配置",
      hint: "绑定 agent env secret（推荐）或设置实例环境变量 RUNNINGHUB_API_KEY",
    });
  } else if (!bindingKey) {
    checks.push({
      code: "runninghub_api_key_instance_only",
      level: "warn",
      message: "仅实例环境变量提供了 RUNNINGHUB_API_KEY",
      hint: "推荐为该 agent 绑定专属的 env secret RUNNINGHUB_API_KEY",
    });
  } else {
    checks.push({
      code: "runninghub_api_key_present",
      level: "info",
      message: "RUNNINGHUB_API_KEY 已配置（agent env 绑定）",
    });
  }

  const spec = resolveWorkflowSpec(ctx.config);
  if (spec) {
    checks.push({
      code: "runninghub_workflow_resolved",
      level: "info",
      message: spec.kind === "app" ? `RunningHub AI App: ${spec.id}` : `RunningHub 工作流: ${spec.id}`,
    });
  } else {
    checks.push({
      code: "runninghub_workflow_unset",
      level: "warn",
      message: "未指定 RunningHub 工作流",
      hint: "把工作流 ID 填入模型栏（纯数字）或 app:<webappId>，也可配置 workflowId / 实例环境变量 RUNNINGHUB_WORKFLOW_ID",
    });
  }

  const status = checks.some((check) => check.level === "error")
    ? "fail"
    : checks.some((check) => check.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ctx.adapterType || "imagegen_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
