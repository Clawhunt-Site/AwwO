import type { UIAdapterModule } from "../types";
import { parseClawworkStdoutLine } from "@paperclipai/adapter-clawwork-local/ui";
import { buildClawworkLocalConfig } from "@paperclipai/adapter-clawwork-local/ui";
import { ClawworkLocalConfigFields } from "./config-fields";

export const clawworkLocalUIAdapter: UIAdapterModule = {
  type: "clawwork_local",
  label: "ClawWork (relay)",
  parseStdoutLine: parseClawworkStdoutLine,
  ConfigFields: ClawworkLocalConfigFields,
  buildAdapterConfig: buildClawworkLocalConfig,
};
