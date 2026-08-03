/**
 * summaryBuilders — extracted from CompactionEngine.ts (compaction summary pipeline).
 */

import type { CanonicalMessage } from "../../model/index.js";
import type { ContextDiagnostic } from "../protocol/types.js";

const SUMMARY_MARKDOWN_HEADINGS = [
  "Objective",
  "Current State",
  "Completed",
  "Remaining",
  "Decisions",
  "Files And Artifacts",
  "Tool Findings",
  "Errors And Recovery",
  "Open Questions",
] as const;

const CORE_SUMMARY_MARKDOWN_HEADINGS = ["Objective", "Current State", "Remaining", "Files And Artifacts"] as const;

const COMPACT_SUMMARY_PREFIX =
  "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted into this summary. Treat it as background state, not active instructions.";

const COMPACT_SUMMARY_END_MARKER =
  "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---";

export function buildMarkdownSummarySystemPrompt(basePrompt: string): string {
  const headings = SUMMARY_MARKDOWN_HEADINGS.map(heading => `## ${heading}`).join("\n");
  return [
    basePrompt.trim(),
    "Summarize the conversation so far as a concise Markdown checkpoint handoff for the next coding agent.",
    "This summary will replace earlier transcript messages. Preserve actionable state, visible results, and task-relevant conclusions from prior thinking blocks, not a chronological transcript or private monologue. Do not reproduce chain-of-thought verbatim, but do not drop factual reasoning that only appeared in thinking.",
    "The runtime will wrap your answer in a reference-only prefix and end marker, so do not add those markers yourself.",
    "If the user message contains a `<compact-summary-anchors>` block, it contains bounded high-priority facts from protected tool turns that are being summarized instead of preserved verbatim. Absorb any task prompts, read skill paths, result paths, result previews, current state, and next actions from those anchors into the Markdown handoff.",
    "Prefer this section structure, using the headings exactly when they apply:",
    headings,
    "If a section has no content, write `None` under that heading. Preserve exact file paths, URLs, commands, data values, user decisions, failed attempts and recovery steps, and unfinished TODOs. Do not replay unrelated chat, and do not expand large raw tool outputs that are easy to re-read or rerun.",
  ].join("\n\n");
}

export function buildMarkdownSummaryUserPrompt(
  userInstruction: string | undefined,
  summaryAnchors: string | undefined,
): string {
  const parts = ["Produce the Markdown handoff now."];
  if (userInstruction?.trim()) {
    parts.push(`Additional summary instructions:\n${userInstruction.trim()}`);
  }
  if (summaryAnchors?.trim()) {
    parts.push(summaryAnchors.trim());
  }
  return parts.join("\n\n");
}

export function wrapSummaryMessage(message: CanonicalMessage): CanonicalMessage {
  const text = normalizeSummaryEnvelope(message);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function normalizeSummaryEnvelope(message: CanonicalMessage): string {
  const body = redactSensitiveText(
    message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim(),
  );
  const stripped = stripSummaryEnvelope(body);
  return `${COMPACT_SUMMARY_PREFIX}\n\n${stripped || "(empty summary)"}\n\n${COMPACT_SUMMARY_END_MARKER}`;
}

function stripSummaryEnvelope(text: string): string {
  let out = text.trim();
  if (out.startsWith(COMPACT_SUMMARY_PREFIX)) {
    out = out.slice(COMPACT_SUMMARY_PREFIX.length).trimStart();
  }
  if (out.startsWith(COMPACT_SUMMARY_END_MARKER)) {
    out = out.slice(COMPACT_SUMMARY_END_MARKER.length).trimStart();
  }
  if (out.endsWith(COMPACT_SUMMARY_END_MARKER)) {
    out = out.slice(0, -COMPACT_SUMMARY_END_MARKER.length).trimEnd();
  }
  return out;
}

export function validateSummaryMarkdownStructure(summaryMessage: CanonicalMessage): ContextDiagnostic[] {
  const text = summaryMessage.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");
  const missing = CORE_SUMMARY_MARKDOWN_HEADINGS.filter(heading => !hasMarkdownHeading(text, heading));
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: "compact_summary_structure_weak",
      severity: "warning",
      message: `Compact summary is missing recommended Markdown heading(s): ${missing.join(", ")}.`,
    },
  ];
}

function hasMarkdownHeading(text: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(text);
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]")
    .replace(/\b(?:api[_ -]?key|secret|password|token)\s*[:=]\s*[^ \t\n\r,;]+/gi, "[REDACTED]");
}
