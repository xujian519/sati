import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";

export type WriteFileInput = {
  filePath: string;
  content: string;
  allowOverwrite?: boolean;
};

export function createWriteFileTool(): PilotDeckToolDefinition<WriteFileInput> {
  return {
    name: "write_file",
    aliases: ["Write"],
    description:
      "Create or overwrite a UTF-8 text file. Both filePath and content are required — content is the full file body to write.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["filePath", "content"],
      additionalProperties: false,
      properties: {
        filePath: {
          type: "string",
          description: "Relative or absolute path of the file to create or overwrite.",
        },
        content: {
          type: "string",
          description: "The full text content to write into the file. Must not be omitted.",
        },
        allowOverwrite: {
          type: "boolean",
          description: "Set to true to allow overwriting an existing file. Defaults to false.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: (input) => input.allowOverwrite === true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.filePath, context, { forWrite: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      if (context.fileHistory) {
        await context.fileHistory.trackEdit(
          resolved.absolutePath,
          context.messageId ?? context.turnId,
        );
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
