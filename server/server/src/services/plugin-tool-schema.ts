/**
 * Server-side validation of plugin tool-call parameters against the tool's
 * declared JSON Schema.
 *
 * Blocker 4 of the agent-capability bridge (see
 * `docs/node-agent-capability-bridge-design.md` §3.4): the MCP schema handed to
 * the model only *guides* it — a misbehaving or compromised model can still send
 * malformed / out-of-contract arguments. The host MUST re-validate server-side,
 * before any worker / super-runtime dispatch, and fail closed on mismatch.
 *
 * Schema source is runtime-aware (the bridge passes the right one in):
 * - paperclip JS tools → `RegisteredTool.parametersSchema` (in-memory registry)
 * - super plugin tools → super runtime record `tools[].inputSchema`
 */

import Ajv2020 from "ajv/dist/2020.js";
import { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/** Thrown when tool-call parameters do not satisfy the declared schema. */
export class ToolParameterValidationError extends Error {
  constructor(
    readonly toolName: string,
    readonly detail: string,
  ) {
    super(`tool "${toolName}" parameters failed schema validation: ${detail}`);
    this.name = "ToolParameterValidationError";
  }
}

// One Ajv instance, compiled validators cached by schema identity. `strict:false`
// keeps us lenient about vendor schema quirks (the goal is rejecting clearly
// out-of-contract input, not enforcing meta-schema purity); formats add common
// string formats (uri, email, date-time) that plugin schemas often use.
// Interop guard mirrors super-plugin-manifest.ts: under NodeNext ESM the CJS
// default may arrive wrapped in `.default`.
const AjvCtor = (Ajv2020 as unknown as { default?: unknown }).default ?? Ajv2020;
const applyFormats = (addFormats as unknown as { default?: unknown }).default ?? addFormats;
const ajv = new (AjvCtor as new (opts: unknown) => {
  compile: (schema: unknown) => ValidateFunction;
})({ allErrors: true, strict: false, allowUnionTypes: true });
(applyFormats as (a: unknown) => void)(ajv);

const validatorCache = new WeakMap<object, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  validatorCache.set(schema, fn);
  return fn;
}

/**
 * Validate `parameters` against `schema`. Throws {@link ToolParameterValidationError}
 * on mismatch.
 *
 * Fail-closed posture: a malformed schema (one Ajv cannot compile) is treated as
 * a validation failure, not a pass — a tool whose contract we cannot enforce must
 * not execute with unchecked input.
 *
 * A nullish schema means the tool declared no parameter contract at all: only
 * an empty/absent argument object is accepted (anything else is out of contract).
 * An empty `{}` schema is a VALID JSON Schema meaning "allow any value" — it is
 * compiled and passed to Ajv like any other schema (not treated as "no params").
 */
export function assertValidToolParameters(
  schema: Record<string, unknown> | null | undefined,
  parameters: unknown,
  toolName: string,
): void {
  if (schema == null) {
    const empty =
      parameters == null ||
      (typeof parameters === "object" &&
        !Array.isArray(parameters) &&
        Object.keys(parameters as Record<string, unknown>).length === 0);
    if (!empty) {
      throw new ToolParameterValidationError(
        toolName,
        "tool declares no parameters but arguments were supplied",
      );
    }
    return;
  }

  let validate: ValidateFunction;
  try {
    validate = compile(schema);
  } catch (err) {
    throw new ToolParameterValidationError(
      toolName,
      `unusable parameter schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Async schemas (`{"$async": true}`) make `validate()` return a Promise, which
  // is truthy — `if (!validate(...))` would fail OPEN and silently admit invalid
  // input. We do not support async validation; treat it as unusable, fail-closed.
  if ((validate as { $async?: boolean }).$async) {
    throw new ToolParameterValidationError(
      toolName,
      "async ($async) parameter schemas are not supported",
    );
  }

  const result: unknown = validate(parameters);
  if (result instanceof Promise) {
    throw new ToolParameterValidationError(
      toolName,
      "parameter schema produced an async validator, which is not supported",
    );
  }
  if (!result) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw new ToolParameterValidationError(toolName, detail || "invalid parameters");
  }
}
