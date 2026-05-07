import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePolitDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";

export type EditFileInput = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export function createEditFileTool(): PolitDeckToolDefinition<EditFileInput> {
  return {
    name: "edit_file",
    aliases: ["Edit"],
    description: "Edit a workspace text file by replacing an exact string.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["filePath", "oldString", "newString"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    execute: async (input, context) => {
      if (input.oldString.length === 0) {
        throw new PolitDeckToolRuntimeError("invalid_tool_input", "oldString must not be empty.");
      }

      const resolved = resolvePolitDeckWorkspacePath(input.filePath, context, { mustExist: true, forWrite: true });
      if (!resolved.ok) {
        throw new PolitDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const content = await readTextFile(resolved.absolutePath);
      const occurrences = countOccurrences(content, input.oldString);
      if (occurrences === 0) {
        throw new PolitDeckToolRuntimeError("invalid_tool_input", "oldString was not found.");
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new PolitDeckToolRuntimeError(
          "invalid_tool_input",
          "oldString occurs more than once. Set replaceAll to true to replace all occurrences.",
        );
      }

      const nextContent = input.replaceAll
        ? content.split(input.oldString).join(input.newString)
        : content.replace(input.oldString, input.newString);
      await writeTextFile(resolved.absolutePath, nextContent, { allowOverwrite: true });

      const replacements = input.replaceAll ? occurrences : 1;
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
