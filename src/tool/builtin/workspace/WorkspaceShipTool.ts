/**
 * `workspace_ship` — register check on outgoing text (J-Space controller's `ship`).
 *
 * Report-only: it inspects the given file for inner-register leakage and
 * failure signatures and reports findings. It never blocks delivery — it
 * completes successfully whether or not it finds anything.
 */
import { readFile } from "node:fs/promises";
import type { SatiToolDefinition } from "../../protocol/types.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { scanRegisterLeak } from "../../../context/workspace/registerLeak.js";
import { resolveSatiWorkspacePath } from "../filesystem/pathSafety.js";

export type WorkspaceShipInput = {
  file: string;
};

export type WorkspaceShipOutput = {
  clean: boolean;
  findings: string[];
};

export function createWorkspaceShipTool(): SatiToolDefinition<WorkspaceShipInput, WorkspaceShipOutput> {
  return {
    name: "workspace_ship",
    title: "Workspace Ship",
    description:
      "Inspect a file for inner-register leakage and failure signatures before it ships: dense-track symbols (⇒, ⟸, 💀…) in prose, state markers, a 'verified/confirmed' claim that does not state its coverage, and repetition loops. Report-only — it reports findings but does not block delivery. Use before delivering a file that summarizes or finalizes a long task.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["file"],
      additionalProperties: false,
      properties: {
        file: { type: "string", description: "Path to the file to inspect (relative to cwd or absolute)." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["clean", "findings"],
      additionalProperties: false,
      properties: {
        clean: { type: "boolean", description: "True when nothing was found." },
        findings: { type: "array", items: { type: "string" }, description: "Reported findings (never blocks)." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      // 与 read_file 一致的路径安全：限制在 workspace 根内，绝对路径不得绕过 cwd。
      const resolved = resolveSatiWorkspacePath(input.file, context, { mustExist: true });
      if (!resolved.ok) {
        throw new SatiToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }
      let text: string;
      try {
        text = await readFile(resolved.absolutePath, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `workspace_ship: cannot read ${input.file}: ${message}`,
        );
      }
      const result = scanRegisterLeak(text);
      const findings = result.findings.map(finding =>
        finding.line !== undefined ? `line ${finding.line}: ${finding.text}` : finding.text,
      );
      return {
        content: [{ type: "json", value: { clean: result.clean, findings } }],
        data: { clean: result.clean, findings },
      };
    },
  };
}
