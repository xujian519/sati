/**
 * 工具错误结果的内容格式化（ToolRuntime 的纯函数部分）。
 *
 * 从 `ToolRuntime.ts` 拆出（P2.9，issue #646）：只做错误文本拼装，不触碰
 * 运行时状态。`formatToolErrorContent` 供失败/拒绝路径的 content 使用，
 * `flattenToolOutputText` 供成功路径的证据 Receipt 使用。
 */

import type { SatiToolResultContent } from "../protocol/types.js";

/** 工具输出内容文本摘录（供证据 Receipt resultText）。 */
export function flattenToolOutputText(content: SatiToolResultContent[]): string {
  return content
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.value);
      if (block.type === "file") return block.path;
      return "";
    })
    .join("\n")
    .trim();
}

export function formatToolErrorContent(recoveryMessage: string, details?: Record<string, unknown>): string {
  const rawDetails = formatRawToolErrorDetails(details);
  return rawDetails ? `${recoveryMessage}\n\n${rawDetails}` : recoveryMessage;
}

function formatRawToolErrorDetails(details?: Record<string, unknown>): string | undefined {
  if (!details) {
    return undefined;
  }

  const lines: string[] = [];
  const command = readStringDetail(details, "command");
  const exitCode = details.exitCode;
  const timedOut = details.timedOut;
  const durationMs = details.durationMs;

  if (command || exitCode !== undefined || timedOut !== undefined || durationMs !== undefined) {
    lines.push("Raw tool details:");
    if (command) lines.push(`- command: ${command}`);
    if (exitCode !== undefined) lines.push(`- exit_code: ${String(exitCode)}`);
    if (timedOut !== undefined) lines.push(`- timed_out: ${String(timedOut)}`);
    if (durationMs !== undefined) lines.push(`- duration_ms: ${String(durationMs)}`);
  }

  const diagnostic = readStringDetail(details, "diagnostic");
  if (diagnostic) {
    lines.push("", "Diagnostic:", diagnostic.trimEnd());
  }

  appendRawStream(lines, "stdout", readStringDetail(details, "stdout"));
  appendRawStream(lines, "stderr", readStringDetail(details, "stderr"));

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function appendRawStream(lines: string[], label: "stdout" | "stderr", value: string | undefined): void {
  if (!value || value.length === 0) {
    return;
  }
  lines.push("", `${label}:`, value.trimEnd());
}

function readStringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}
