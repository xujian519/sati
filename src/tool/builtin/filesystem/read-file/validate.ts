import path from "node:path";
import type { SatiToolRuntimeContext } from "../../../protocol/types.js";
import type { SatiToolValidationResult } from "../../../protocol/schema.js";
import { hasBinaryExtension, isBlockedDevicePath, parsePdfPageRange } from "../fileTypeSafety.js";
import { MAX_PDF_PAGES_PER_REQUEST } from "./constants.js";
import type { ReadFileInput } from "./types.js";

/** 请求级入参校验：范围/页数形式、设备文件与二进制扩展名的前置拒绝（不触达文件系统）。 */
export function validateReadFileInput(input: ReadFileInput, context: SatiToolRuntimeContext): SatiToolValidationResult {
  if (input.offset !== undefined && input.offset < 1) {
    return {
      ok: false,
      issues: [{ path: "offset", code: "invalid_schema", message: "offset must be a 1-based line number (>= 1)." }],
    };
  }
  if (input.limit !== undefined && input.limit < 0) {
    return {
      ok: false,
      issues: [{ path: "limit", code: "invalid_schema", message: "limit must be greater than or equal to 0." }],
    };
  }
  if (typeof input.pages === "string" && input.pages.trim().length === 0) {
    const { pages: _pages, ...rest } = input;
    input = rest as ReadFileInput;
  }
  if (input.pages !== undefined) {
    const parsed = parsePdfPageRange(input.pages);
    if (!parsed) {
      return {
        ok: false,
        issues: [{ path: "pages", code: "invalid_schema", message: 'pages must use formats like "1-5" or "3".' }],
      };
    }
    if (parsed.lastPage - parsed.firstPage + 1 > MAX_PDF_PAGES_PER_REQUEST) {
      return {
        ok: false,
        issues: [
          {
            path: "pages",
            code: "invalid_schema",
            message: `pages exceeds the maximum of ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`,
          },
        ],
      };
    }
  }

  const absolutePath = path.resolve(context.cwd, input.file_path);
  if (isBlockedDevicePath(absolutePath)) {
    return {
      ok: false,
      issues: [
        {
          path: "file_path",
          code: "invalid_schema",
          message: "device files that block or stream infinitely are not readable.",
        },
      ],
    };
  }
  if (hasBinaryExtension(absolutePath)) {
    return {
      ok: false,
      issues: [
        {
          path: "file_path",
          code: "invalid_schema",
          message:
            "binary files are not supported by read_file. Use the relevant document, spreadsheet, or presentation skill for Office files; convert archives or other binary files to a supported text, PDF, or image format before inspection. Use send_attachment/send_file only when the user wants this file sent back through the current channel.",
        },
      ],
    };
  }
  return { ok: true, input };
}
