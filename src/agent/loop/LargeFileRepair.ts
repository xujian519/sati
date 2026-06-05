import type {
  CanonicalToolCall,
} from "../../model/index.js";
import type { PilotDeckToolResult } from "../../tool/index.js";

export type LargeFileRepairDecision =
  | { type: "continue"; prompt: string; purpose: string; strip?: "assistant" | "error_pair" }
  | { type: "stop"; reason: string };

export type LargeFileRepairToolContext = {
  outputTruncated: boolean;
  repairedToolCalls: boolean;
  finishReason?: string;
};

const MAX_PRE_DRAFT_REPAIR_ATTEMPTS = 3;
const MAX_POST_DRAFT_REPAIR_ATTEMPTS = 3;
const LARGE_FILE_OUTPUT_RETRY_TOKENS = 16_384;
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_READ_TOOLS = new Set(["read_file", "grep", "glob"]);

export class LargeFileRepair {
  private preDraftAttempts = 0;
  private postDraftAttempts = 0;
  private wroteFile = false;
  private pendingLargeFileRepair = false;
  private recentFilePaths: string[] = [];

  get recommendedMaxOutputTokens(): number {
    return LARGE_FILE_OUTPUT_RETRY_TOKENS;
  }

  onNoToolCalls(): LargeFileRepairDecision | undefined {
    if (!this.pendingLargeFileRepair || this.wroteFile) {
      return undefined;
    }
    return this.tryPreDraft("large_file_no_tool_call", "assistant");
  }

  analyzeToolResults(
    results: PilotDeckToolResult[],
    context: LargeFileRepairToolContext,
  ): LargeFileRepairDecision | undefined {
    this.recordWrites(results);

    if (this.wroteFile) {
      const risk = hasPostDraftRisk(results);
      if (!risk) {
        this.pendingLargeFileRepair = false;
        return undefined;
      }
      return this.tryPostDraft("large_file_post_draft_repair");
    }

    if (hasPreDraftLargeFileRisk(results, context)) {
      this.pendingLargeFileRepair = true;
      return this.tryPreDraft("large_file_pre_draft_repair", "error_pair");
    }

    return undefined;
  }

  recoverFromRepairedTruncation(toolCalls: CanonicalToolCall[]): LargeFileRepairDecision | undefined {
    if (!toolCalls.some((call) => FILE_WRITE_TOOLS.has(call.name))) {
      return undefined;
    }
    if (this.wroteFile) {
      return this.tryPostDraft("large_file_repaired_truncation_after_write");
    }
    this.pendingLargeFileRepair = true;
    return this.tryPreDraft("large_file_repaired_truncation", "assistant");
  }

  private tryPreDraft(purpose: string, strip: "assistant" | "error_pair"): LargeFileRepairDecision {
    if (this.preDraftAttempts >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair failed before any workspace file was created after ${this.preDraftAttempts} attempts.`,
      };
    }
    this.preDraftAttempts++;
    return {
      type: "continue",
      purpose,
      strip,
      prompt: preDraftPrompt(this.preDraftAttempts),
    };
  }

  private tryPostDraft(purpose: string): LargeFileRepairDecision {
    if (this.postDraftAttempts >= MAX_POST_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair stopped after ${this.postDraftAttempts} post-draft attempts. A workspace file already exists; report the current file path and remaining gap.`,
      };
    }
    this.postDraftAttempts++;
    return {
      type: "continue",
      purpose,
      prompt: postDraftPrompt(this.recentFilePaths, this.postDraftAttempts),
    };
  }

  private recordWrites(results: PilotDeckToolResult[]): void {
    for (const result of results) {
      if (result.type !== "success" || !FILE_WRITE_TOOLS.has(result.toolName)) {
        continue;
      }
      this.wroteFile = true;
      const filePath = readResultFilePath(result.data);
      if (filePath) {
        this.recentFilePaths = [
          filePath,
          ...this.recentFilePaths.filter((path) => path !== filePath),
        ].slice(0, 5);
      }
    }
  }
}

function preDraftPrompt(attempt: number): string {
  const lastAttempt = attempt >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS;
  return [
    "Your previous attempt at a large file did not create a workspace file.",
    "Recover using the normal file tools. Create a real draft file inside the workspace now.",
    "Use write_file with a complete, smaller draft: include the required filename and a content field. Keep the draft well under the output budget, but make it structurally valid and useful.",
    "For HTML, write a complete document with doctype, head, style, body, script if needed, and closing tags. For prose or reports, write the opening sections plus clear continuation markers.",
    "After this draft exists, inspect it with read_file and extend or patch it in later turns instead of trying to emit the full final artifact in one tool call.",
    "Do not use shell heredocs, terminal append tricks, or paths outside the workspace. Do not only describe the plan; call a file tool now.",
    lastAttempt ? "This is the final pre-draft repair attempt; prioritize creating any valid draft file over completeness." : "",
  ].filter(Boolean).join("\n");
}

function postDraftPrompt(filePaths: string[], attempt: number): string {
  const fileText = filePaths.length > 0
    ? `Known written file(s): ${filePaths.join(", ")}.`
    : "A workspace file has already been written.";
  const lastAttempt = attempt >= MAX_POST_DRAFT_REPAIR_ATTEMPTS;
  return [
    fileText,
    "Continue with the ordinary repair chain: read the existing file if you need context, then use edit_file or write_file with small focused changes to fill the missing parts.",
    "Do not regenerate the whole artifact from scratch. Do not overwrite a useful draft unless you have just read it and are preserving the existing work.",
    "If a mechanical size requirement is still short, append or insert compact sections around stable markers. For HTML, keep the document valid and preserve closing tags.",
    "When the file satisfies the request, stop and report the path plus a concise summary.",
    lastAttempt ? "This is the final post-draft repair attempt; make one focused fix or report the current file and remaining gap." : "",
  ].filter(Boolean).join("\n");
}

function hasPreDraftLargeFileRisk(
  results: PilotDeckToolResult[],
  context: LargeFileRepairToolContext,
): boolean {
  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (!FILE_WRITE_TOOLS.has(result.toolName)) {
      return false;
    }
    const issues = readIssues(result);
    if (
      result.toolName === "write_file" &&
      hasRequiredIssue(issues, "content")
    ) {
      return true;
    }
    if (context.outputTruncated && issues.some((issue) => issue.code === "required")) {
      return true;
    }
    return looksLikeLargeFileError(result.error.message);
  });
}

function hasPostDraftRisk(results: PilotDeckToolResult[]): boolean {
  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (FILE_READ_TOOLS.has(result.toolName)) {
      return false;
    }
    if (result.error.code === "permission_denied" || result.error.code === "permission_required") {
      return false;
    }
    return FILE_WRITE_TOOLS.has(result.toolName) || looksLikeLargeFileError(result.error.message);
  });
}

function readIssues(result: PilotDeckToolResult): { path: string; code: string }[] {
  if (result.type !== "error") {
    return [];
  }
  const issues = result.error.details?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isRecord(issue)) {
      return [];
    }
    const path = typeof issue.path === "string" ? issue.path : "";
    const code = typeof issue.code === "string" ? issue.code : "";
    return [{ path, code }];
  });
}

function hasRequiredIssue(issues: { path: string; code: string }[], pathPart: string): boolean {
  return issues.some((issue) =>
    issue.code === "required" &&
    normalizeIssuePath(issue.path).includes(pathPart)
  );
}

function normalizeIssuePath(path: string): string {
  return path.replace(/^\$\.?/u, "");
}

function readResultFilePath(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const filePath = data.filePath;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function looksLikeLargeFileError(message: string): boolean {
  return /(?:output token|truncated|too large|large file|large artifact|max_output|missing required parameter `content`|required parameter `content` is missing)/iu.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
