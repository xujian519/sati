import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic, PilotPatentsConfig } from "./types.js";

/**
 * Parse the optional `patents` section of `sati.yaml`.
 *
 *   patents:
 *     downloadDir: ~/Patents
 *     modelHints:
 *       strong: { provider: anthropic, model: claude-sonnet }
 *       cheap:  { model: deepseek-v4-flash }
 *
 * `downloadDir` is optional; when present it must be a non-empty string.
 * A leading `~/` is expanded to `$HOME` at use time (patent_pdf_download's
 * resolveOutputDir), not here — parse keeps the raw value.
 * `modelHints` is optional; each entry must map to an object with a non-empty
 * `model` string and an optional non-empty `provider` string.
 * Unknown fields produce non-fatal warnings so future additions don't break
 * older deployments.  Returns `undefined` when the section is missing or
 * empty so callers can keep the field off the snapshot entirely.
 */
export function parsePatentsConfig(
  rawPatents: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotPatentsConfig | undefined {
  if (rawPatents === undefined) {
    return undefined;
  }
  if (!isRecord(rawPatents)) {
    diagnostics.push({
      code: "PATENTS_CONFIG_INVALID",
      severity: "fatal",
      message: "patents config must be an object.",
      path: "patents",
      recoverable: false,
    });
    return undefined;
  }

  const result: PilotPatentsConfig = {};

  if (rawPatents.downloadDir !== undefined) {
    if (typeof rawPatents.downloadDir !== "string" || rawPatents.downloadDir.trim().length === 0) {
      diagnostics.push({
        code: "PATENTS_DOWNLOAD_DIR_INVALID",
        severity: "fatal",
        message: "patents.downloadDir must be a non-empty string.",
        path: "patents.downloadDir",
        recoverable: false,
      });
    } else {
      result.downloadDir = rawPatents.downloadDir.trim();
    }
  }

  if (rawPatents.modelHints !== undefined) {
    if (!isRecord(rawPatents.modelHints)) {
      diagnostics.push({
        code: "PATENTS_MODEL_HINTS_INVALID",
        severity: "fatal",
        message: "patents.modelHints must be an object of hint name → { provider?, model }.",
        path: "patents.modelHints",
        recoverable: false,
      });
    } else {
      const hints: Record<string, { provider?: string; model: string }> = {};
      let valid = true;
      for (const [name, value] of Object.entries(rawPatents.modelHints)) {
        if (!isRecord(value) || typeof value.model !== "string" || value.model.trim().length === 0) {
          diagnostics.push({
            code: "PATENTS_MODEL_HINTS_INVALID",
            severity: "fatal",
            message: `patents.modelHints.${name} must map to { provider?, model } with a non-empty model.`,
            path: `patents.modelHints.${name}`,
            recoverable: false,
          });
          valid = false;
          continue;
        }
        if (
          value.provider !== undefined &&
          (typeof value.provider !== "string" || value.provider.trim().length === 0)
        ) {
          diagnostics.push({
            code: "PATENTS_MODEL_HINTS_INVALID",
            severity: "fatal",
            message: `patents.modelHints.${name}.provider must be a non-empty string when present.`,
            path: `patents.modelHints.${name}.provider`,
            recoverable: false,
          });
          valid = false;
          continue;
        }
        hints[name] =
          typeof value.provider === "string"
            ? { provider: value.provider.trim(), model: value.model.trim() }
            : { model: value.model.trim() };
      }
      if (valid && Object.keys(hints).length > 0) {
        result.modelHints = hints;
      }
    }
  }

  for (const key of Object.keys(rawPatents)) {
    if (key !== "downloadDir" && key !== "modelHints") {
      diagnostics.push({
        code: "PATENTS_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown patents config field ${key}.`,
        path: `patents.${key}`,
        recoverable: true,
      });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
