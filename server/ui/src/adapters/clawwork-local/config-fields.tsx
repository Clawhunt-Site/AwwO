import type { AdapterConfigFieldsProps } from "../types";

// ClawWork has no adapter-specific config fields beyond the standard model
// (a SuperClaw relay tier: core/plus/max), command, and env inputs the generic
// form already renders. Relay base/key are injected by SuperClaw, never entered
// here. So there are no extra fields to render.
export function ClawworkLocalConfigFields(_props: AdapterConfigFieldsProps) {
  return null;
}
