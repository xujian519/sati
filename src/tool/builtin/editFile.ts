import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";

export type EditFileInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export function createEditFileTool(): PilotDeckToolDefinition<EditFileInput> {
  return {
    name: "edit_file",
    aliases: ["Edit"],
    description:
      "Edit a workspace text file by replacing an exact string match.\n\nUsage:\n- Use this tool for targeted changes to an existing file.\n- old_string must appear in the target file.\n- If old_string is not unique, either provide a more specific old_string or set replace_all to update every occurrence.\n- Use replace_all when renaming or replacing repeated text across the same file.\n- If the file is outside the workspace or does not exist, the tool returns a controlled error.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "Relative or absolute path of the file to edit. The path must resolve inside the workspace.",
        },
        old_string: {
          type: "string",
          description: "The exact substring to find and replace. It must appear in the target file.",
        },
        new_string: {
          type: "string",
          description: "The replacement string that will replace old_string.",
        },
        replace_all: {
          type: "boolean",
          description:
            "When true, replace all occurrences of old_string. Defaults to false, which requires old_string to be unique.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    execute: async (input, context) => {
      if (input.old_string.length === 0) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "old_string must not be empty.");
      }

      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { mustExist: true, forWrite: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      if (context.fileHistory) {
        await context.fileHistory.trackEdit(
          resolved.absolutePath,
          context.messageId ?? context.turnId,
        );
      }

      const content = await readTextFile(resolved.absolutePath);
      const occurrences = countOccurrences(content, input.old_string);
      if (occurrences === 0) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "old_string was not found.");
      }
      if (occurrences > 1 && !input.replace_all) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "old_string occurs more than once. Set replace_all to true to replace all occurrences.",
        );
      }

      const nextContent = input.replace_all
        ? content.split(input.old_string).join(input.new_string)
        : content.replace(input.old_string, input.new_string);
      await writeTextFile(resolved.absolutePath, nextContent, { allowOverwrite: true });

      const replacements = input.replace_all ? occurrences : 1;
      return {
        content: [{ type: "text", text: `Updated ${resolved.relativePath} (${replacements} replacement).` }],
        data: {
          filePath: resolved.relativePath,
          replacements,
          changed: nextContent !== content,
        },
      };
    },
  };
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}
