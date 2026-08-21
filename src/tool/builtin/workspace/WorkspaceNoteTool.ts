/**
 * `workspace_note` — record a ledger edit (J-Space controller's `note`).
 *
 * Reads the current ledger from the session store, applies the note, and
 * persists the result. It records and reports state — it never chooses a
 * solution or blocks the agent. Malformed edits are reported as rejected, and
 * a mixed call never drops an independent valid edit.
 */
import type { SatiToolDefinition } from "../../protocol/types.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import {
  applyWorkspaceNote,
  emptyWorkspaceLedger,
  type WorkspaceNoteInput,
  type WorkspaceNoteResult,
} from "../../../session/workspace/WorkspaceLedger.js";

export type WorkspaceNoteToolOutput = WorkspaceNoteResult;

export function createWorkspaceNoteTool(): SatiToolDefinition<WorkspaceNoteInput, WorkspaceNoteToolOutput> {
  return {
    name: "workspace_note",
    title: "Workspace Note",
    description:
      "Record an edit to the workspace ledger, the durable state segment re-injected before each model call. The ledger has five sections: Goal (what done means), Core (up to two live shared anchors), Verified (numbered, append-only checkpoints with verifier + coverage), Open (numbered questions, each with the test that would settle it), and Next (the single next action, never empty). Pass any subset of goal/next/core/check/by/open/settledBy/close in one call; malformed edits are reported as rejected and independent valid edits are still applied.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string", description: "One line: what 'done' means." },
        next: { type: "string", description: "The single next action. Never empty on an open ledger." },
        core: { type: "string", description: "A core hub entry: `name — the one fact that makes it matter`." },
        coreSlot: { type: "integer", enum: [1, 2], description: "Explicit live slot to swap (1 or 2)." },
        check: { type: "string", description: "A checkpoint claim that now holds." },
        by: { type: "string", description: "What verified the checkpoint, including its coverage." },
        open: { type: "string", description: "An open question." },
        settledBy: { type: "string", description: "The cheapest test that would settle the open question." },
        close: { type: "integer", description: "Open question number to close (requires a check in the same call)." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["state", "rejected", "changed"],
      additionalProperties: false,
      properties: {
        state: { type: "object", description: "The resulting ledger state." },
        rejected: { type: "array", items: { type: "string" }, description: "Rejected edits (with the reason)." },
        changed: { type: "boolean", description: "Whether any edit was applied." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      if (!context.workspaceLedger) {
        throw new SatiToolRuntimeError(
          "unsupported_tool",
          "workspace_note is unavailable because the workspace ledger is not enabled.",
        );
      }
      const current = (await context.workspaceLedger.read()) ?? emptyWorkspaceLedger();
      const result = applyWorkspaceNote(current, input);
      if (result.changed) {
        await context.workspaceLedger.write(result.state, {
          sessionId: context.sessionId,
          turnId: context.turnId,
        });
      }
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
