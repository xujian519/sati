/**
 * 批量导入时单个候选的落库请求：扫描模式走 JSON `/api/skills/import`，
 * 文件夹选择模式走 multipart `/api/skills/import-upload`。从原 `submitBatch`
 * 的 try 块逐行搬出（错误消息保持原样）。
 */
import { authenticatedFetch } from "../../../../../utils/api";
import { api } from "../../shared/api";
import { stripRootPrefix } from "../frontmatter";
import type { BatchCandidate, ImportMode, ImportScope } from "./types";

export type BatchImportContext = {
  /** 选择文件夹模式下的根目录名，用于拼 multipart 的 paths 前缀。 */
  parentName: string;
  scope: ImportScope;
  projectPath: string | null;
  mode: ImportMode;
  force: boolean;
};

export async function importCandidate(candidate: BatchCandidate, ctx: BatchImportContext): Promise<void> {
  if (candidate.sourcePath) {
    // Scan mode — use path-based import
    await api<{ ok: boolean }>("/api/skills/import", {
      sourcePath: candidate.sourcePath,
      slug: candidate.folderName,
      scope: ctx.scope,
      projectPath: ctx.scope === "project" ? ctx.projectPath : null,
      mode: ctx.mode,
      force: ctx.force,
    });
    return;
  }

  // Pick folder mode — use multipart upload
  const rootName = ctx.parentName;
  const formData = new FormData();
  const paths: string[] = [];
  const prefix = rootName + "/" + candidate.folderName;
  for (const file of candidate.files) {
    formData.append("files", file);
    const rel = file.webkitRelativePath || file.name;
    paths.push(stripRootPrefix(rel, prefix));
  }
  formData.append("paths", JSON.stringify(paths));
  formData.append("slug", candidate.folderName);
  formData.append("scope", ctx.scope);
  if (ctx.scope === "project" && ctx.projectPath) formData.append("projectPath", ctx.projectPath);
  if (ctx.force) formData.append("force", "true");

  const r = await authenticatedFetch("/api/skills/import-upload", {
    method: "POST",
    body: formData,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
  }
}
