import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GatewayOutboundAttachment } from "../../../gateway/index.js";

export type PreparedImAttachment = {
  name: string;
  mimeType?: string;
  buffer: Buffer;
  fileType: "image" | "file";
  path?: string;
};

export type ImAttachmentDeliveryOptions = {
  maxBytes: number;
  sendPrepared(attachment: PreparedImAttachment): Promise<void>;
  sendTextFallback(text: string): Promise<void>;
  logger?: { info?(message: string): void; warn?(message: string): void; error?(message: string): void };
};

export class ImAttachmentDelivery {
  constructor(private readonly options: ImAttachmentDeliveryOptions) {}

  async send(attachment: GatewayOutboundAttachment): Promise<boolean> {
    if (attachment.source === "local_path" && attachment.path) {
      await this.options.sendTextFallback(`附件 ${attachment.path} 需要授权后才能发送。`);
      return false;
    }

    try {
      const prepared = await this.prepare(attachment);
      await this.options.sendPrepared(prepared);
      return true;
    } catch (error) {
      this.options.logger?.error?.(`IM attachment send failed: ${formatError(error)}`);
      await this.options.sendTextFallback(formatImAttachmentFallback(attachment));
      return false;
    }
  }

  async sendMentionedLocalAttachments(input: {
    chatId: string;
    text: string;
    markSent(chatId: string, path: string): boolean;
  }): Promise<void> {
    const paths = extractLocalPathsFromText(input.text);
    if (paths.length === 0) return;
    this.options.logger?.info?.(`IM detected mentioned local paths: ${paths.join(", ")}`);
    for (const path of paths) {
      if (!isPathWithin(process.cwd(), path)) {
        this.options.logger?.warn?.(`IM skip mentioned attachment outside workspace: ${path}`);
        continue;
      }
      if (!isRegularFile(path)) {
        this.options.logger?.warn?.(`IM skip mentioned attachment because it is not a file: ${path}`);
        continue;
      }
      if (!input.markSent(input.chatId, path)) continue;
      await this.send({
        type: guessMimeTypeFromName(path)?.startsWith("image/") ? "image" : "file",
        path,
        name: path.split(/[\\/]/).pop(),
        mimeType: guessMimeTypeFromName(path),
        source: "authorized_path",
      });
    }
  }

  private async prepare(attachment: GatewayOutboundAttachment): Promise<PreparedImAttachment> {
    const name = sanitizeFilename(attachment.name ?? attachment.path?.split(/[\\/]/).pop() ?? "attachment");
    const buffer = attachment.content
      ? Buffer.from(attachment.content, "base64")
      : attachment.path
        ? await readFile(attachment.path)
        : undefined;
    if (!buffer) throw new Error("attachment has neither content nor path");
    if (buffer.byteLength > this.options.maxBytes) {
      throw new Error(`attachment ${name} is ${buffer.byteLength} bytes (limit ${this.options.maxBytes})`);
    }
    const mimeType = attachment.mimeType ?? guessMimeTypeFromName(name);
    const fileType = attachment.type === "image" || mimeType?.startsWith("image/") ? "image" : "file";
    return { name, mimeType, buffer, fileType, ...(attachment.path ? { path: attachment.path } : {}) };
  }
}

export function guessMimeTypeFromName(name: string | undefined): string | undefined {
  const lower = name?.toLowerCase() ?? "";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return undefined;
}

export function formatImAttachmentFallback(attachment: GatewayOutboundAttachment): string {
  const name = attachment.name ?? attachment.path?.split(/[\\/]/).pop() ?? "附件";
  const pathText = attachment.path ? `，可在本机查看：${attachment.path}` : "";
  return `附件发送失败：${name}${pathText}`;
}

function extractLocalPathsFromText(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    addExistingAbsolutePath(paths, match[1]);
  }
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/(?:\/private\/tmp|\/tmp|\/Users)\//g)) {
      const candidate = longestExistingPathPrefix(line.slice(match.index));
      if (candidate) paths.add(candidate);
    }
  }
  return [...paths];
}

function addExistingAbsolutePath(paths: Set<string>, raw: string | undefined): void {
  const candidate = cleanPathCandidate(raw);
  if (candidate && isAbsolute(candidate) && isRegularFile(candidate)) {
    paths.add(resolve(candidate));
  }
}

function longestExistingPathPrefix(raw: string): string | undefined {
  const candidate = cleanPathCandidate(raw);
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const segments = candidate.split("/");
  for (let end = segments.length; end > 1; end -= 1) {
    const prefix = segments.slice(0, end).join("/") || "/";
    if (isRegularFile(prefix)) return resolve(prefix);
  }
  return undefined;
}

function cleanPathCandidate(raw: string | undefined): string | undefined {
  const cleaned = raw?.trim().replace(/^["'“”‘’]+/, "").replace(/["'“”‘’，。；：、)）\]}>]+$/g, "");
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").trim().slice(0, 180) || "attachment.bin";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
