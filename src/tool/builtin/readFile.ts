import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePolitDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";

export type ReadFileInput = {
  filePath: string;
  offset?: number;
  limit?: number;
};

export function createReadFileTool(): PolitDeckToolDefinition<ReadFileInput> {
  return {
    name: "read_file",
    aliases: ["Read"],
    description: "Read a UTF-8 text file from the PolitDeck workspace.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePolitDeckWorkspacePath(input.filePath, context, { mustExist: true });
      if (!resolved.ok) {
        throw new PolitDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const content = await readTextFile(resolved.absolutePath);
      const lines = content.split(/\r?\n/);
      const offset = Math.max(0, input.offset ?? 0);
      const limit = input.limit === undefined ? lines.length : Math.max(0, input.limit);
      const selected = lines.slice(offset, offset + limit);
      const truncated = offset > 0 || offset + limit < lines.length;

      return {
        content: [{ type: "text", text: selected.join("\n") }],
        data: {
          filePath: resolved.relativePath,
          startLine: selected.length > 0 ? offset + 1 : offset,
          endLine: selected.length > 0 ? offset + selected.length : offset,
          truncated,
        },
        metadata: { truncated },
      };
    },
  };
}
