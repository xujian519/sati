/**
 * AgentLoop 工具失败分析纯函数（从 AgentLoop.ts 拆出）。
 *
 * 包含 doom-loop 指纹、重复失败标注、权限拒绝收集等确定性逻辑。
 */

import type { SatiToolErrorResult, SatiToolResult } from "../../tool/index.js";
import type { AgentPermissionDenial } from "../protocol/result.js";
import { appendTextToFirstContent } from "./messages.js";
import { isRecord } from "./misc.js";

export type ToolFailureAnalysis = {
  currentFingerprint?: string;
  repeatedKeys: Set<string>;
};

export function detectRepeatedToolFailure(
  results: SatiToolResult[],
  lastFingerprint: string | undefined,
): ToolFailureAnalysis {
  const keys = buildToolFailureKeys(results);
  const fingerprint = keys.length > 0 ? keys.join("\n") : undefined;
  const repeatedKeys = findRepeatedValues(keys);
  if (fingerprint && fingerprint === lastFingerprint) {
    for (const key of keys) {
      repeatedKeys.add(key);
    }
  }
  if (!fingerprint) {
    return { repeatedKeys };
  }
  return {
    currentFingerprint: fingerprint,
    repeatedKeys,
  };
}

export function buildToolFailureKeys(results: SatiToolResult[]): string[] {
  return results
    .filter((result): result is SatiToolErrorResult => result.type === "error")
    .map(result => {
      const recovery = readRecoveryMetadata(result);
      return toolFailureKey(result, recovery);
    })
    .sort();
}

export function buildInvalidFingerprint(results: SatiToolResult[]): string {
  return results
    .filter(
      (result): result is SatiToolErrorResult => result.type === "error" && result.error.code === "invalid_tool_input",
    )
    .map(result => `${result.toolName}::${result.error.message}`)
    .sort()
    .join("\n");
}

export function annotateRepeatedToolFailures(results: SatiToolResult[], repeatedKeys: Set<string>): SatiToolResult[] {
  if (repeatedKeys.size === 0) {
    return results;
  }

  return results.map(result => {
    if (result.type !== "error") {
      return result;
    }
    const recovery = readRecoveryMetadata(result);
    if (!repeatedKeys.has(toolFailureKey(result, recovery))) {
      return result;
    }
    const avoidRetryReason =
      typeof recovery?.avoidRetryReason === "string"
        ? recovery.avoidRetryReason
        : "The same tool, error code, and recovery class repeated. Retrying unchanged is likely to fail again.";
    const repeatedText =
      `\n\nRepeated failure: ${avoidRetryReason}\n` +
      "Change at least one of the tool, parameters, path, scope, permission path, or explain the blocker in text.";
    return {
      ...result,
      content: appendTextToFirstContent(result.content, repeatedText),
      metadata: {
        ...(result.metadata ?? {}),
        recovery: recovery
          ? {
              ...recovery,
              avoidRetryReason,
              repeatedFailure: true,
            }
          : {
              avoidRetryReason,
              repeatedFailure: true,
            },
      },
    };
  });
}

function toolFailureKey(result: SatiToolErrorResult, recovery: Record<string, unknown> | undefined): string {
  return `${result.toolName}::${result.error.code}::${recovery?.failureClass ?? "unknown"}`;
}

function findRepeatedValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    } else {
      seen.add(value);
    }
  }
  return repeated;
}

function readRecoveryMetadata(result: SatiToolErrorResult): Record<string, unknown> | undefined {
  const recovery = result.metadata?.recovery;
  return isRecord(recovery) ? recovery : undefined;
}

export function collectPermissionDenials(results: SatiToolResult[]): AgentPermissionDenial[] {
  return results.flatMap(result => {
    if (
      result.type === "error" &&
      (result.error.code === "permission_denied" ||
        result.error.code === "permission_required" ||
        result.error.code === "permission_cancelled")
    ) {
      return [
        {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          errorCode: result.error.code,
        },
      ];
    }
    return [];
  });
}
