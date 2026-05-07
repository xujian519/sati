import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePolitDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";

export type WriteFileInput = {
  filePath: string;
  content: string;
  allowOverwrite?: boolean;
};

export function createWriteFileTool(): PolitDeckToolDefinition<WriteFileInput> {
  return {
    name: "write_file",
    aliases: ["Write"],
    description: "Create or overwrite a UTF-8 text file in the PolitDeck workspace.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["filePath", "content"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
        allowOverwrite: { type: "boolean" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: (input) => input.allowOverwrite === true,
    execute: async (input, context) => {
      const resolved = resolvePolitDeckWorkspacePath(input.filePath, context, { forWrite: true });
      if (!resolved.ok) {
        throw new PolitDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const action = await writeTextFile(resolved.absolutePath, input.content, {
        allowOverwrite: input.allowOverwrite,
      });

      return {
        content: [{ type: "text", text: `${action === "created" ? "Created" : "Overwrote"} ${resolved.relativePath}.` }],
        data: {
          filePath: resolved.relativePath,
          action,
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
        },
      };
    },
  };
}
