import type { SatiToolValidationResult } from "../../protocol/schema.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { MAX_PATENTS } from "./constants.js";
import { normalizeUniquePatents } from "./outputPaths.js";
import type { PatentPdfDownloadInput } from "./types.js";

/** 请求级入参校验：专利号归一/去重、路径穿越、outputDir 类型与超时区间。 */
export function validatePatentPdfDownloadInput(
  input: PatentPdfDownloadInput,
  context: SatiToolRuntimeContext,
): SatiToolValidationResult {
  void context;
  if (!input || typeof input !== "object") {
    return { ok: false, issues: [{ path: "", code: "invalid_type", message: "input must be an object" }] };
  }
  const { patents, outputDir, pageTimeoutSec, downloadTimeoutMs, timeoutMs, force } = input as PatentPdfDownloadInput;

  if (!Array.isArray(patents) || patents.length === 0) {
    return { ok: false, issues: [{ path: "patents", code: "required", message: "patents is required" }] };
  }
  const unique = normalizeUniquePatents(patents);
  if (unique.length === 0) {
    return {
      ok: false,
      issues: [
        { path: "patents", code: "invalid_schema", message: "patents must contain at least one non-empty number" },
      ],
    };
  }
  if (unique.length > MAX_PATENTS) {
    return {
      ok: false,
      issues: [{ path: "patents", code: "invalid_schema", message: `patents exceeds the maximum of ${MAX_PATENTS}` }],
    };
  }
  // P1-02：归一化（已去除 / 与空白）后仍含 \ 或 .. 的专利号会污染文件名
  // 拼接（Windows 分隔符 / 目录穿越），直接拒绝。
  const traversal = unique.filter(n => n.includes("\\") || n.includes(".."));
  if (traversal.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "patents",
          code: "invalid_schema",
          message: `patents contain path traversal characters: ${traversal.join(", ")}`,
        },
      ],
    };
  }
  if (outputDir !== undefined && typeof outputDir !== "string") {
    return {
      ok: false,
      issues: [{ path: "outputDir", code: "invalid_type", message: "outputDir must be a string" }],
    };
  }
  if (
    pageTimeoutSec !== undefined &&
    (!Number.isInteger(pageTimeoutSec) || pageTimeoutSec < 5 || pageTimeoutSec > 60)
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "pageTimeoutSec",
          code: "invalid_schema",
          message: "pageTimeoutSec must be an integer between 5 and 60",
        },
      ],
    };
  }
  if (
    downloadTimeoutMs !== undefined &&
    (!Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 5_000 || downloadTimeoutMs > 300_000)
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "downloadTimeoutMs",
          code: "invalid_schema",
          message: "downloadTimeoutMs must be between 5000 and 300000",
        },
      ],
    };
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
    return {
      ok: false,
      issues: [{ path: "timeoutMs", code: "invalid_schema", message: "timeoutMs must be between 1 and 300000" }],
    };
  }
  if (force !== undefined && typeof force !== "boolean") {
    return {
      ok: false,
      issues: [{ path: "force", code: "invalid_type", message: "force must be a boolean" }],
    };
  }
  return { ok: true, input: { ...(input as PatentPdfDownloadInput), patents: unique } };
}
