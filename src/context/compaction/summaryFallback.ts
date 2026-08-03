/**
 * summaryFallback — extracted from CompactionEngine.ts (compaction summary pipeline).
 */

import { flattenToolResultContentText, type CanonicalMessage, type CanonicalToolCallBlock } from "../../model/index.js";
import { collectToolNamesByCallId } from "./protectedContext.js";
import { redactSensitiveText, wrapSummaryMessage } from "./summaryBuilders.js";

const COMPACT_SUMMARY_FALLBACK_MAX_CHARS = 8_000;

export function buildDeterministicFallbackSummary(
  messages: CanonicalMessage[],
  reason: string | undefined,
): CanonicalMessage {
  const facts = collectFallbackSummaryFacts(messages);
  let body = [
    "## Objective",
    facts.objective || "None",
    "",
    "## Current State",
    facts.currentState || "None",
    "",
    "## Completed",
    formatBulletList(facts.completed, 8),
    "",
    "## Remaining",
    formatBulletList(facts.remaining, 8),
    "",
    "## Decisions",
    formatBulletList(facts.decisions, 8),
    "",
    "## Files And Artifacts",
    formatBulletList(facts.files, 12),
    "",
    "## Tool Findings",
    formatBulletList(facts.toolFindings, 8),
    "",
    "## Thinking",
    formatBulletList(facts.thinking, 8),
    "",
    "## Errors And Recovery",
    formatBulletList([...(reason ? [reason] : []), ...facts.errors], 8),
    "",
    "## Open Questions",
    formatBulletList(facts.openQuestions, 8),
  ].join("\n");

  if (body.length > COMPACT_SUMMARY_FALLBACK_MAX_CHARS) {
    body = `${body.slice(0, COMPACT_SUMMARY_FALLBACK_MAX_CHARS - 40).trimEnd()}\n...[fallback summary truncated]`;
  }

  return wrapSummaryMessage({
    role: "assistant",
    content: [{ type: "text", text: body }],
  });
}

type FallbackSummaryFacts = {
  objective: string;
  currentState: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  files: string[];
  toolFindings: string[];
  thinking: string[];
  errors: string[];
  openQuestions: string[];
};

function collectFallbackSummaryFacts(messages: CanonicalMessage[]): FallbackSummaryFacts {
  const userTexts: string[] = [];
  const completed: string[] = [];
  const remaining: string[] = [];
  const decisions: string[] = [];
  const files: string[] = [];
  const toolFindings: string[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  const openQuestions: string[] = [];
  const toolNamesByCallId = collectToolNamesByCallId(messages);
  const currentStateBits: string[] = [];

  for (const message of messages) {
    const visibleText = visibleTextFromMessage(message);
    if (message.role === "user" && visibleText) {
      userTexts.push(visibleText);
      if (visibleText.includes("?")) {
        openQuestions.push(shortenFallbackText(visibleText, 220));
      }
      currentStateBits.push(shortenFallbackText(visibleText, 220));
    }
    if (message.role === "assistant") {
      const calls = message.content.filter(block => block.type === "tool_call") as CanonicalToolCallBlock[];
      if (calls.length > 0) {
        completed.push(`Called tool(s): ${calls.map(call => call.name).join(", ")}`);
        for (const call of calls) {
          collectFallbackPathsFromValue(call.input, files);
          if (call.name === "Task" || call.name === "read_skill") {
            const callText = buildToolCallSummaryText(call);
            toolFindings.push(callText);
          }
        }
      }
      if (visibleText) {
        completed.push(shortenFallbackText(visibleText, 220));
      }
    }
    for (const block of message.content) {
      if (block.type === "thinking") {
        thinking.push(shortenFallbackText(block.reasoningContent ?? block.text, 260));
        continue;
      }
      if (block.type === "tool_result") {
        const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
        const text = flattenToolResultContentText(block.content);
        const summary = summarizeFallbackToolResult(toolName, block.toolCallId, text, block.isError === true);
        toolFindings.push(summary);
        if (block.isError || /(?:error|failed|exception|traceback|timeout|fatal)/i.test(text)) {
          errors.push(shortenFallbackText(summary, 280));
        }
        collectFallbackPathsFromText(text, files);
        continue;
      }
      if (block.type === "tool_result_reference") {
        files.push(shortenFallbackText(block.readFilePath ?? block.path, 280));
        toolFindings.push(
          `Referenced ${shortenFallbackText(block.readFilePath ?? block.path, 180)} (${block.originalBytes} bytes)`,
        );
        if (block.preview) {
          toolFindings.push(shortenFallbackText(block.preview, 220));
        }
        continue;
      }
      if (block.type === "text") {
        collectFallbackPathsFromText(block.text, files);
      }
    }
  }

  if (userTexts.length === 0) {
    currentStateBits.push("No user messages were recoverable from the compacted window.");
  }
  remaining.push(
    userTexts.length > 0
      ? `Continue from the latest user request: ${shortenFallbackText(userTexts[userTexts.length - 1]!, 260)}`
      : "Continue from the preserved tail and verify current repository state before changing anything.",
  );
  if (userTexts.length > 1) {
    decisions.push(`Earlier user asks were: ${shortenFallbackText(userTexts.slice(0, -1).join(" | "), 260)}`);
  }

  return {
    objective: userTexts.length > 0 ? shortenFallbackText(userTexts[0]!, 280) : "Unknown from deterministic fallback.",
    currentState:
      currentStateBits.length > 0
        ? shortenFallbackText(currentStateBits.join(" / "), 320)
        : "Unknown from deterministic fallback.",
    completed: uniqueFallbackEntries(completed),
    remaining: uniqueFallbackEntries(remaining),
    decisions: uniqueFallbackEntries(decisions),
    files: uniqueFallbackEntries(files),
    toolFindings: uniqueFallbackEntries(toolFindings),
    thinking: uniqueFallbackEntries(thinking),
    errors: uniqueFallbackEntries(errors),
    openQuestions: uniqueFallbackEntries(openQuestions),
  };
}

function visibleTextFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function collectFallbackPathsFromValue(value: unknown, files: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    collectFallbackPathsFromText(value, files);
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFallbackPathsFromValue(item, files);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && /(?:path|file|read|cwd|dir|url|uri|location)/i.test(key)) {
      files.push(shortenFallbackText(entry, 280));
    }
    collectFallbackPathsFromValue(entry, files);
  }
}

function collectFallbackPathsFromText(text: string, files: string[]): void {
  const matches = text.match(/(?:\/|~\/?|[A-Za-z]:\\)[^\s`'"")\]}<>]+/g) ?? [];
  for (const match of matches) {
    files.push(shortenFallbackText(match.replace(/[.,:;]+$/g, ""), 280));
  }
}

function summarizeFallbackToolResult(toolName: string, toolCallId: string, text: string, isError: boolean): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const preview = shortenFallbackText(normalized, 260);
  return `[${toolName}] ${isError ? "error" : "result"} for ${toolCallId}: ${preview || "None"}`;
}

function buildToolCallSummaryText(call: CanonicalToolCallBlock): string {
  const input = summarizeFallbackInput(call.input);
  return `[${call.name}] call ${call.id}${input ? ` ${input}` : ""}`;
}

function summarizeFallbackInput(value: unknown): string {
  const rendered = JSON.stringify(value, circularJsonReplacer());
  if (!rendered) {
    return "";
  }
  return shortenFallbackText(rendered, 220);
}

function shortenFallbackText(text: string, maxChars: number): string {
  const normalized = redactSensitiveText(text.replace(/\s+/g, " ").trim());
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.max(0, maxChars - 16);
  return `${normalized.slice(0, head).trimEnd()}...[truncated]`;
}

function formatBulletList(items: string[], limit: number): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    lines.push(`- ${normalized}`);
    if (lines.length >= limit) {
      break;
    }
  }
  return lines.length > 0 ? lines.join("\n") : "None";
}

function uniqueFallbackEntries(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function circularJsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
}
