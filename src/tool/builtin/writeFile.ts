import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";

export type WriteFileInput = {
  file_path: string;
  content: string;
  allow_overwrite?: boolean;
};

export function createWriteFileTool(): PilotDeckToolDefinition<WriteFileInput> {
  return {
    name: "write_file",
    aliases: ["Write"],
    description:
      "Write a UTF-8 text file inside the workspace.\n\nUsage:\n- content must be the full file body to write.\n- Use this tool when creating a new file or replacing the entire contents of a file.\n- Prefer edit_file for targeted modifications to an existing file.\n- If the target file already exists, set allow_overwrite to true to overwrite it.\n- If the path is outside the workspace or overwrite is not allowed, the tool returns a controlled error.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "Relative or absolute path of the file to create or overwrite. The path must resolve inside the workspace.",
        },
        content: {
          type: "string",
          description: "The full text content to write into the file.",
        },
        allow_overwrite: {
          type: "boolean",
          description:
            "When true, allow this call to overwrite an existing file. Omit or set to false to require create-only behavior.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: (input) => input.allow_overwrite !== false,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { forWrite: true });
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
        allowOverwrite: input.allow_overwrite ?? false,
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
