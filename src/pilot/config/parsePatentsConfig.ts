import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic, PilotPatentsConfig } from "./types.js";

/**
 * Parse the optional `patents` section of `sati.yaml`.
 *
 *   patents:
 *     downloadDir: ~/Patents
 *
 * `downloadDir` is optional; when present it must be a non-empty string.
 * A leading `~/` is expanded to `$HOME` at use time (patent_pdf_download's
 * resolveOutputDir), not here — parse keeps the raw value.
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

  for (const key of Object.keys(rawPatents)) {
    if (key !== "downloadDir") {
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
