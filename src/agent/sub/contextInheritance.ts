/**
 * S5-S8 — partial context inheritance for forked subagents.
 *
 * - **S5**: clone the parent's `readFileState` (file-staleness cache) so the
 *   subagent's read_file freshness checks don't poison the parent.
 * - **S6**: re-use `getUserContext()` / `getSystemContext()` snapshots from
 *   the parent unless explicitly overridden.
 * - **S7**: drop the `<claudeMd>` block when `omitClaudeMd: true`.
 * - **S8**: drop the `<git-status>` block when `omitGitStatus: true`.
 *
 * In PilotDeck the only "context blocks" we have today are encoded as XML-like
 * sections in the assembled system prompt (`PromptAssembler` output). We
 * implement S7/S8 by post-processing the system prompt string, since that's
 * the simplest cache-stable cut. If/when richer context structures land we'll
 * push the filtering deeper into the assembler.
 */

import type { SubagentDefinition } from "./builtinSubagentTypes.js";

/** Read-file freshness cache contract. Match the shape used by `read_file`. */
export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

export type ReadFileStateEntry = {
  /** Last modified time (ms epoch) the agent observed when reading the file. */
  mtimeMs: number;
  /** Optional content hash captured at last read. */
  contentHash?: string;
};

/** S5 — deep clone the parent's read-file cache. */
export function cloneReadFileState(parent: ReadFileStateMap | undefined): ReadFileStateMap {
  if (!parent) return new Map();
  const out: ReadFileStateMap = new Map();
  for (const [key, value] of parent.entries()) {
    out.set(key, { mtimeMs: value.mtimeMs, contentHash: value.contentHash });
  }
  return out;
}

/** S7+S8 — drop claudeMd / git-status blocks from the assembled system prompt. */
export function applySystemPromptFilters(
  systemPrompt: string,
  definition: SubagentDefinition,
): string {
  let next = systemPrompt;
  if (definition.omitClaudeMd) {
    next = stripXmlBlock(next, "claude-md");
    next = stripXmlBlock(next, "claudeMd");
    next = stripXmlBlock(next, "agents-md");
    next = stripXmlBlock(next, "project-instructions");
  }
  if (definition.omitGitStatus) {
    next = stripXmlBlock(next, "git-status");
    next = stripXmlBlock(next, "gitStatus");
  }
  return next.trimEnd();
}

function stripXmlBlock(input: string, tag: string): string {
  const escaped = tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)\\s*<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>\\s*`, "g");
  return input.replace(re, "\n");
}
