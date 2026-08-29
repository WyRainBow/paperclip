import type { UIAdapterModule } from "../types";
import { parseQoderStdoutLine } from "@paperclipai/adapter-qoder-local/ui";
import { QoderLocalConfigFields } from "./config-fields";
import { buildQoderLocalConfig } from "@paperclipai/adapter-qoder-local/ui";

export const qoderLocalUIAdapter: UIAdapterModule = {
  type: "qoder_local",
  label: "Qoder",
  parseStdoutLine: parseQoderStdoutLine,
  ConfigFields: QoderLocalConfigFields,
  buildAdapterConfig: buildQoderLocalConfig,
};
