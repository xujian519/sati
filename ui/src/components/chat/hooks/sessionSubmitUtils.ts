import { logError } from "../../../utils/logging";
import {
  CONTENT_REFERENCE_ATTACHMENT_KIND,
  serializableReference,
  type ContentReference,
} from "../../../types/contentReference";
import { safeLocalStorage } from "../utils/chatStorage";
import type { ChatAttachment } from "../types/types";

export type UploadedAttachmentFile = {
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
};

export function buildAttachmentPathNote(files: UploadedAttachmentFile[]): string {
  if (!files.length) {
    return "";
  }

  const lines = files.map(file => `- ${file.name}: ${file.path}`);
  return `\n\n[Files attached by user and available for reading in the project:]\n${lines.join("\n")}`;
}

/**
 * 读取工具授权设置（`sati-settings`）；损坏时告警并回退全保守默认值。
 * 注意 fallback 有意不含 `projectSortOrder`（存量行为，消费方按缺省容错），
 * 故不标注 `SatiSettings` 返回类型。
 */
export function readToolsSettings() {
  try {
    const savedSettings = safeLocalStorage.getItem("sati-settings");
    if (savedSettings) {
      return JSON.parse(savedSettings);
    }
  } catch (error) {
    logError("Error loading tools settings:", error);
  }

  return {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  };
}

export function contentReferenceToAttachment(reference: ContentReference): ChatAttachment {
  return {
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    name: reference.source.fileName,
    path: reference.source.relativePath,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    contentReference: serializableReference(reference),
    createdAt: reference.createdAt,
    mimeType: "application/vnd.sati.content-reference+json",
  };
}
