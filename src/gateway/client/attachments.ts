/**
 * src/gateway/client — 聊天附件管线。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮 3）：附件 → 内容块解析（含
 * AttachmentResolver 解析 image/pdf/file）+ 注册路径注记 + read_file
 * 可检视性判定 + 已注册附件收集。含 IO（stat/realpath/AttachmentResolver）。
 */

import { stat, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentInput } from "../../agent/index.js";
import type { CanonicalContentBlock } from "../../model/index.js";
import { AttachmentResolver, type AttachmentRequest } from "../../context/attachments/AttachmentResolver.js";
import type { ChannelAttachment } from "../protocol/types.js";

const ATTACHMENT_PATH_NOTE_MARKER = "[Registered attachment files in this session:]";
const READ_FILE_BINARY_ATTACHMENT_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".key",
  ".numbers",
]);

export async function buildAgentInputWithAttachments(
  message: string,
  attachments: ChannelAttachment[] | undefined,
  allowedReadFiles: string[],
): Promise<AgentInput> {
  const resolvedAttachments = await attachmentsToContentBlocks(attachments);
  const attachmentBlocks = resolvedAttachments.blocks;
  const pathNote = buildAttachmentPathNote(
    attachments,
    new Set(allowedReadFiles),
    resolvedAttachments.directContentPaths,
    resolvedAttachments.hasDiagnostics,
  );
  if (attachmentBlocks.length === 0 && !pathNote) {
    return { type: "text", text: message };
  }
  const blocks: CanonicalContentBlock[] = [];
  if (message && message.length > 0) {
    blocks.push({ type: "text", text: message });
  }
  for (const block of attachmentBlocks) {
    blocks.push(block);
  }
  if (pathNote) {
    blocks.push(pathNote);
  }
  return { type: "blocks", content: blocks };
}

export function buildAttachmentPathNote(
  attachments: ChannelAttachment[] | undefined,
  allowedReadFiles: Set<string>,
  directContentPaths: Set<string>,
  hasDiagnostics: boolean,
): CanonicalContentBlock | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!attachment.path) continue;
    const normalized = safeAllowedAttachmentPath(attachment.path, allowedReadFiles);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const fallbackName = normalized.split(/[\\/]/).pop() || "attachment";
    const name =
      String(attachment.name || fallbackName)
        .replace(/[\r\n]+/g, " ")
        .trim() || fallbackName;
    lines.push(`- ${name}: ${normalized}`);
  }

  if (lines.length === 0) return undefined;
  const guidance = hasDiagnostics
    ? attachmentDiagnosticsGuidance(attachments, allowedReadFiles)
    : "These are path references for reuse. If an image/PDF is already visible in this turn, do not call read_file just to view it.";
  return {
    type: "text",
    text: `\n\n${ATTACHMENT_PATH_NOTE_MARKER}\n${lines.join("\n")}\n${guidance}`,
  };
}

export function attachmentDiagnosticsGuidance(attachments: ChannelAttachment[], allowedReadFiles: Set<string>): string {
  const hasInspectableAttachment = attachments.some(attachment => {
    if (!attachment.path) return false;
    if (!safeAllowedAttachmentPath(attachment.path, allowedReadFiles)) return false;
    return isReadFileInspectableAttachment(attachment);
  });
  if (!hasInspectableAttachment) {
    return "Some attachments were not shown inline. These registered files are not directly inspectable with read_file; ask for a supported export or convert them before inspection.";
  }
  return "Some attachments were not shown inline. Use read_file with the exact path only for readable text, image, PDF, or notebook attachments; Office/archive/binary files need conversion before inspection.";
}

export function isReadFileInspectableAttachment(attachment: ChannelAttachment): boolean {
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  if (attachment.type === "image" || mimeType.startsWith("image/")) return true;
  if (mimeType === "application/pdf") return true;
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/json" || mimeType.endsWith("+json")) return true;

  const pathOrName = attachment.path || attachment.name || "";
  const extension = extname(pathOrName).toLowerCase();
  if (extension === ".pdf" || extension === ".ipynb") return true;
  if (READ_FILE_BINARY_ATTACHMENT_EXTENSIONS.has(extension)) return false;
  return true;
}

export function safeAllowedAttachmentPath(path: string, allowedReadFiles: Set<string>): string | undefined {
  const normalized = resolve(path);
  if (allowedReadFiles.has(normalized)) return normalized;
  return undefined;
}

export async function collectRegisteredAttachmentReadFiles(
  attachments: ChannelAttachment[] | undefined,
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const allowed = new Set<string>();

  for (const attachment of attachments) {
    if (!attachment.path || !attachment.metadata?.channelKey) continue;
    try {
      const info = await stat(attachment.path);
      if (!info.isFile()) continue;
      allowed.add(resolve(attachment.path));
      allowed.add(resolve(await realpath(attachment.path)));
    } catch {
      // Missing or inaccessible attachments are handled by attachment resolution diagnostics.
    }
  }

  return [...allowed];
}

export async function attachmentsToContentBlocks(
  attachments: ChannelAttachment[] | undefined,
): Promise<{ blocks: CanonicalContentBlock[]; directContentPaths: Set<string>; hasDiagnostics: boolean }> {
  if (!attachments || attachments.length === 0) {
    return { blocks: [], directContentPaths: new Set<string>(), hasDiagnostics: false };
  }
  const blocks: CanonicalContentBlock[] = [];
  const resolverRequests: AttachmentRequest[] = [];
  const resolverRequestPaths: Array<string | undefined> = [];
  const directContentPaths = new Set<string>();
  const diagnostics: string[] = [];

  for (const att of attachments) {
    if (att.type === "image" && att.content && att.mimeType) {
      blocks.push({
        type: "image",
        source: "base64",
        data: att.content,
        mimeType: att.mimeType,
        ...(typeof att.bytes === "number" ? { bytes: att.bytes } : {}),
      });
      if (att.path) directContentPaths.add(resolve(att.path));
      continue;
    }

    if (att.type === "text" && att.content) {
      blocks.push({ type: "text", text: att.content });
      continue;
    }

    if (!att.path) continue;
    if (att.type === "image" || att.mimeType?.startsWith("image/")) {
      resolverRequests.push({ type: "image", path: att.path, mimeType: att.mimeType });
      resolverRequestPaths.push(resolve(att.path));
    } else if (att.mimeType === "application/pdf" || att.path.toLowerCase().endsWith(".pdf")) {
      resolverRequests.push({ type: "pdf", path: att.path });
      resolverRequestPaths.push(resolve(att.path));
    } else {
      resolverRequests.push({ type: "file", path: att.path });
      resolverRequestPaths.push(resolve(att.path));
    }
  }

  if (resolverRequests.length > 0) {
    const resolved = await new AttachmentResolver().resolveAll(resolverRequests);
    blocks.push(...resolved.blocks);
    for (const diagnostic of resolved.diagnostics) {
      if (diagnostic.severity === "error" || diagnostic.severity === "warning") {
        diagnostics.push(diagnostic.message);
      }
    }
    if (resolved.blocks.length > 0 && diagnostics.length === 0) {
      for (const requestPath of resolverRequestPaths) {
        if (requestPath) directContentPaths.add(requestPath);
      }
    }
  }

  if (diagnostics.length > 0) {
    blocks.push({
      type: "text",
      text: `[Attachment diagnostics]\n${diagnostics.map(message => `- ${message}`).join("\n")}`,
    });
  }

  return { blocks, directContentPaths, hasDiagnostics: diagnostics.length > 0 };
}
