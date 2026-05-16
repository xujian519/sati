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
    description: "Find workspace files matching a glob pattern. Returns a list of matching file paths.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.json').",
        },
        path: {
          type: "string",
          description: "Relative directory to search within. Defaults to workspace root.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of file paths to return. Defaults to 1000.",
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
