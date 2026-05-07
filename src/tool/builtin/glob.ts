import path from "node:path";
import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { globPatternToRegExp } from "./filesystem/globPattern.js";
import { resolvePolitDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { walkFiles } from "./filesystem/walk.js";

export type GlobInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export function createGlobTool(): PolitDeckToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["Glob"],
    description: "Find workspace files matching a glob pattern.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePolitDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PolitDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const matcher = globPatternToRegExp(input.pattern);
      const limit = input.limit ?? 1_000;
      const files = (await walkFiles(resolved.absolutePath))
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => matcher.test(file))
        .sort();
      const selected = files.slice(0, limit);
      const workspaceFiles = selected.map((file) =>
        path.join(resolved.relativePath === "." ? "" : resolved.relativePath, file).split(path.sep).join("/"),
      );
      const truncated = selected.length < files.length;

      return {
        content: [{ type: "text", text: workspaceFiles.join("\n") }],
        data: {
          files: workspaceFiles,
          count: files.length,
          truncated,
        },
        metadata: { truncated },
      };
    },
  };
}
