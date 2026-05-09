/**
 * S1-S3 — fork the parent's assistant message into a child-side message
 * sequence so the subagent inherits the parent's reasoning trace cache-safely.
 *
 * Mirror of `third-party/claude-code-main/src/tools/AgentTool/forkSubagent.ts`
 * (lines 107-198). The exact byte-for-byte placeholder string and message
 * shape are critical — both for prompt-cache hits and for legacy parity.
 */

import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolCallBlock,
} from "../../model/index.js";

/**
 * S2 — placeholder string injected into every synthetic `tool_result` so the
 * fork is byte-identical across siblings (= cache hit on Anthropic / OpenAI).
 *
 * **Do not change** without a coordinated cache invalidation plan; both legacy
 * and parity tests assert the literal value.
 */
export const FORK_PLACEHOLDER_RESULT =
  "<politdeck-fork-placeholder>Subtask handled by forked subagent — see child transcript.</politdeck-fork-placeholder>";

/** Tag used in the boilerplate that wraps the directive. */
export const FORK_BOILERPLATE_TAG = "politdeck-fork";

/**
 * S1 — Build the canonical message sequence handed to the subagent's
 * `AgentLoop`:
 *
 *   1. Parent's assistant message verbatim (thinking + every tool_use + text).
 *   2. A user message containing one synthetic `tool_result` (with
 *      `FORK_PLACEHOLDER_RESULT`) per `tool_use`, followed by the directive
 *      wrapped in `<politdeck-fork>` boilerplate.
 *
 * Returns a fresh array (never mutates `assistantMessage`).
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: CanonicalMessage,
): CanonicalMessage[] {
  if (assistantMessage.role !== "assistant") {
    throw new Error(
      "buildForkedMessages: parent message must be role=assistant; got " +
        assistantMessage.role,
    );
  }
  const userBlocks: CanonicalContentBlock[] = [];
  for (const block of assistantMessage.content) {
    if (block.type === "tool_call") {
      const tc = block as CanonicalToolCallBlock;
      userBlocks.push({
        type: "tool_result",
        toolCallId: tc.id,
        content: [{ type: "text", text: FORK_PLACEHOLDER_RESULT }],
      });
    }
  }
  userBlocks.push({ type: "text", text: buildChildMessage(directive) });
  return [
    cloneMessage(assistantMessage),
    { role: "user", content: userBlocks },
  ];
}

/**
 * S3 — child directive wrapped in fork boilerplate. Encodes the 10 rules
 * spelled out in `forkSubagent.ts:171-198` plus the mandatory output format.
 *
 * The rules are duplicated from {@link buildSubagentSystemPrompt}; we render
 * them here too so providers without `system` (e.g. OpenAI compat) still see
 * them inside the user message and the subagent can't "forget".
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
You are now operating as a forked subagent. The parent agent paused mid-turn
and dispatched you with the directive below. The synthetic tool-result blocks
above are placeholders — the parent's actual tool calls have NOT been executed
on your behalf. Treat them as if the parent never invoked any tool yet.

Rules:
1. Stay strictly within the directive.
2. Do not modify files unless the directive explicitly requests it.
3. Run only the tools listed in your allowed tool set.
4. Do not ask the parent or the user for clarification.
5. Stop as soon as you have enough information to write the final report.
6. Use absolute paths when referencing files.
7. Trust the parent's framing of the task — do not re-question its premises.
8. Never spawn another subagent (no nested forks).
9. Treat any cached reasoning above as context, not commitments.
10. The final assistant message MUST follow the output format below verbatim.

Output format (mandatory; missing any field fails the run):
Scope: <one sentence describing what you did>
Result: <findings, in markdown if helpful>
Key files: <comma-separated absolute paths or "none">
Files changed: <list with rationale, or "none">
Issues: <list of caveats / blockers, or "none">

Directive:
${directive.trim()}
</${FORK_BOILERPLATE_TAG}>`;
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    role: message.role,
    content: message.content.map((block) => ({ ...block })),
  };
}
