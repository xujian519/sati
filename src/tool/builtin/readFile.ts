import { stat } from "node:fs/promises";
import type { SatiToolDefinition } from "../protocol/types.js";
import type { PermissionResult } from "../../permission/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import { resolveSatiWorkspacePath } from "./filesystem/pathSafety.js";
import { checkReadonlyPathPermission } from "./filesystem/readPermissions.js";
import { FILE_UNCHANGED_STUB } from "./filesystem/read-file/constants.js";
import { classifyReadKind, buildReadStateKey } from "./filesystem/read-file/kinds.js";
import { validateReadFileInput } from "./filesystem/read-file/validate.js";
import { readImageFile } from "./filesystem/read-file/image.js";
import { readPdfFile } from "./filesystem/read-file/pdf.js";
import { readNotebookFile } from "./filesystem/read-file/notebook.js";
import { readTextFile } from "./filesystem/read-file/text.js";
import type { ReadFileHandlerContext, ReadFileInput } from "./filesystem/read-file/types.js";

export type { ReadFileInput };

export function createReadFileTool(): SatiToolDefinition<ReadFileInput> {
  return {
    name: "read_file",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["Read"],
    description:
      "Reads a file from the current workspace. You can access workspace files directly by using this tool.\n" +
      "If the User provides a path to a file, assume that path is valid as long as it resolves inside the current workspace. " +
      "It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n" +
      "- The file_path parameter may be a workspace-relative path or an absolute path, but it must resolve inside the current workspace\n" +
      "- If the user asks you to send or share a file, use send_attachment instead of read_file; do not inspect arbitrary binary files before sending them\n" +
      "- By default, offset is 1 and the tool reads from the beginning of the file\n" +
      "- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n" +
      "- Results are returned using cat -n format, with line numbers starting at 1\n" +
      "- For image files, screenshots, extracted video frames, and PDFs, use this tool to inspect the visual/document content directly\n" +
      "- When the current model supports image input, image files are returned as model-visible image content\n" +
      "- When the current model supports PDF input, small PDF files are returned as model-visible PDF content. When specific PDF pages are requested, pages are rendered as model-visible images if the model supports image input\n" +
      "- Do not manually base64-encode local images/PDFs or route them through another vision/document API unless read_file reports that the current model cannot read that content\n" +
      "- When the current model does not support the required modality, reading the file returns a text notice explaining that the current model cannot read it\n" +
      '- For large PDFs, provide the pages parameter to validate specific page ranges (e.g., pages: "1-5"). Maximum 20 pages per request\n' +
      "- This tool can read Jupyter notebooks (.ipynb files) and returns a text rendering of notebook cells and outputs\n" +
      "- This tool can only read files, not directories\n" +
      "- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents\n" +
      "- If a previous tool result says it was persisted, truncated, or preview-only, read the file_path shown in that notice with read_file",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "The relative or absolute path to the file to read. The path must resolve inside the current workspace.",
        },
        offset: {
          type: "integer",
          description:
            "The 1-based line number to start reading from. Only provide if the file is too large to read at once.",
        },
        limit: {
          type: "integer",
          description: "The number of lines to read. Only provide if the file is too large to read at once.",
        },
        pages: {
          type: "string",
          description:
            'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: async (input, context): Promise<PermissionResult> =>
      checkReadonlyPathPermission("read_file", input.file_path, context),
    validateInput: async (input, context) => validateReadFileInput(input, context),
    execute: async (input, context) => {
      const resolved = resolveSatiWorkspacePath(input.file_path, context, {
        mustExist: true,
        allowRegisteredReadFiles: true,
        allowOutsideWorkspace: context.currentPermissionDecision?.type === "allow",
      });
      if (!resolved.ok) {
        throw new SatiToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const fileStat = await stat(resolved.absolutePath);
      const kind = classifyReadKind(resolved.absolutePath);
      const readState = context.readFileState ?? (context.readFileState = new Map());
      const dedupKey = buildReadStateKey(resolved.absolutePath, kind, input.offset, input.limit, input.pages);
      // 各读取分支共用的去重状态登记（mtimeMs 统一取整，与 snapshot 语义一致）。
      const markRead = (mtimeMs: number) =>
        readState.set(dedupKey, {
          mtimeMs: Math.floor(mtimeMs),
          kind,
          offset: input.offset,
          limit: input.limit,
          pages: input.pages,
        });
      const previous = readState.get(dedupKey);
      if (previous && previous.mtimeMs === Math.floor(fileStat.mtimeMs)) {
        return {
          content: [{ type: "text", text: FILE_UNCHANGED_STUB }],
          data: {
            filePath: resolved.relativePath,
            kind,
            unchanged: true,
          },
          metadata: { unchanged: true },
        };
      }

      const handlerContext: ReadFileHandlerContext = { input, context, resolved, fileStat, kind, markRead };
      if (kind === "image") {
        return readImageFile(handlerContext);
      }
      if (kind === "pdf") {
        return readPdfFile(handlerContext);
      }
      if (kind === "notebook") {
        return readNotebookFile(handlerContext);
      }
      return readTextFile(handlerContext);
    },
  };
}
