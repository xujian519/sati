import { isImagePath, isNotebookPath, isPdfPath } from "../fileTypeSafety.js";
import type { ReadKind } from "./types.js";

export function classifyReadKind(filePath: string): ReadKind {
  if (isImagePath(filePath)) {
    return "image";
  }
  if (isPdfPath(filePath)) {
    return "pdf";
  }
  if (isNotebookPath(filePath)) {
    return "notebook";
  }
  return "text";
}

export function buildReadStateKey(
  filePath: string,
  kind: ReadKind,
  offset?: number,
  limit?: number,
  pages?: string,
): string {
  return `${filePath}::${kind}::${offset ?? 1}::${limit ?? "all"}::${pages ?? ""}`;
}
