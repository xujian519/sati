import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";

export type ReadFileInput = {
  file_path: string;
  offset?: number;
  limit?: number;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap

function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return IMAGE_EXTENSIONS.has(ext);
}

function imageMimeType(ext: string): string {
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

export function createReadFileTool(): PilotDeckToolDefinition<ReadFileInput> {
  return {
    name: "read_file",
    aliases: ["Read"],
    description:
      "Read a file from the current workspace.\n\nUsage:\n- Supports UTF-8 text files and image files "
      + "(png, jpg, jpeg, gif, webp).\n- Provide file_path as a workspace-relative path or an absolute path "
      + "that resolves inside the workspace.\n- By default, the tool reads the whole text file; use offset "
      + "and limit when you only need a specific portion.\n- This tool reads files, not directories.\n- If "
      + "the target does not exist, is outside the workspace, or is not readable, the tool returns a controlled error.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "Relative or absolute path of the text file to read. The path must resolve inside the current workspace.",
        },
        offset: {
          type: "integer",
          description:
            "Zero-based line offset to start reading from for text files only. Only provide if the file is too large to read at once.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of lines to return for text files only. Omit to read the entire file, or provide it to target a specific portion.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      if (isImagePath(resolved.absolutePath)) {
        const ext = path.extname(resolved.absolutePath).toLowerCase().slice(1);
        const supportsImage = context.modelMultimodal?.input?.includes("image");

        if (!supportsImage) {
          const fileStat = await stat(resolved.absolutePath);
          return {
            content: [{
              type: "text",
              text: `[Image file: ${input.file_path}, ${fileStat.size} bytes, ${imageMimeType(ext)}. Current model does not support image input.]`,
            }],
            data: { filePath: resolved.relativePath, isImage: true, modelSupportsImage: false },
          };
        }

        const fileStat = await stat(resolved.absolutePath);
        if (fileStat.size > MAX_IMAGE_BYTES) {
          return {
            content: [{
              type: "text",
              text: `[Image file: ${input.file_path}, ${fileStat.size} bytes — exceeds ${MAX_IMAGE_BYTES} byte limit. Cannot display.]`,
            }],
            data: { filePath: resolved.relativePath, isImage: true, tooLarge: true },
          };
        }

        const buffer = await readFile(resolved.absolutePath);
        const mimeType = imageMimeType(ext);
        return {
          content: [{ type: "image", mimeType, data: buffer.toString("base64") }],
          data: { filePath: resolved.relativePath, isImage: true, mimeType, bytes: buffer.byteLength },
        };
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
