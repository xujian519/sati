import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { globPatternToRegExp } from "./filesystem/globPattern.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { walkFiles } from "./filesystem/walk.js";

export type GlobInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export function createGlobTool(): PilotDeckToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["Glob"],
    description:
      "Find workspace files matching a glob pattern.\n\nUsage:\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\".\n- Use this tool when you need to find files by name or wildcard pattern.\n- Provide the optional path parameter to restrict the search to a subdirectory.\n- Use this tool to narrow down candidate files before reading or editing them.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against.",
        },
        path: {
          type: "string",
          description:
            "The directory to search in. If not specified, the workspace root will be used. Must resolve to a directory inside the workspace if provided.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of file paths to return. This is a PilotDeck-specific output cap; defaults to 1000.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
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
