// sqlite 的模块级 helper（从 sqlite.ts 拆出，逐字搬移）。
// 归一化/校验/排序纯函数 + 快照文件工具 + bundle 校验（MemoryBundleValidationError）。
// 全部无 DB 依赖（仅 fs/path + hashText/nowIso），可独立单测。
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MEMORY_EXPORT_FORMAT_VERSION,
  type CaseTraceRecord,
  type DreamPipelineStatus,
  type DreamTraceRecord,
  type IndexTraceRecord,
  type IndexingSettings,
  type L0SessionRecord,
  type MemoryImportableBundle,
  type MemoryManifestEntry,
  type MemoryMessage,
  type MemorySnapshotFileRecord,
} from "../types.js";
import { hashText, nowIso } from "../utils/id.js";

type DbRow = Record<string, unknown>;

export class MemoryBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryBundleValidationError";
  }
}

const GLOBAL_MEMORY_PREFIX = "global/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeMessages(value: unknown): MemoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map(item => ({
      ...(typeof item.msgId === "string" && item.msgId.trim() ? { msgId: item.msgId } : {}),
      role: typeof item.role === "string" && item.role.trim() ? item.role : "user",
      content: typeof item.content === "string" ? item.content : "",
    }));
}

function normalizeL0Row(row: DbRow): L0SessionRecord {
  return {
    l0IndexId: String(row.l0_index_id),
    sessionKey: String(row.session_key),
    timestamp: String(row.timestamp),
    messages: normalizeMessages(parseJson(String(row.messages_json ?? "[]"), [])),
    source: String(row.source ?? ""),
    indexed: Boolean(row.indexed),
    createdAt: String(row.created_at),
  };
}

function sanitizeTraceArray<T extends object>(value: unknown, key: keyof T & string, sortKey: keyof T & string): T[] {
  if (!Array.isArray(value)) return [];
  const sorted = value
    .filter((item): item is T => {
      if (!isRecord(item)) return false;
      const keyed = item as Record<string, unknown>;
      return typeof keyed[key] === "string" && typeof keyed[sortKey] === "string";
    })
    .sort((left, right) => {
      const rightValue = (right as Record<string, unknown>)[sortKey];
      const leftValue = (left as Record<string, unknown>)[sortKey];
      return String(rightValue).localeCompare(String(leftValue));
    });
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of sorted) {
    const id = String((item as Record<string, unknown>)[key]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(item);
  }
  return next;
}

function normalizeIndexTraceRecord(record: IndexTraceRecord): IndexTraceRecord {
  const isNoOp =
    typeof record.isNoOp === "boolean"
      ? record.isNoOp
      : record.status === "completed" && record.storedResults.length === 0;
  const displayStatus =
    typeof record.displayStatus === "string" && record.displayStatus.trim()
      ? record.displayStatus
      : record.status === "error"
        ? "Error"
        : isNoOp
          ? "No-op"
          : record.status === "running"
            ? "Running"
            : "Completed";
  return {
    ...record,
    isNoOp,
    displayStatus,
  };
}

function normalizeDreamTraceRecord(record: DreamTraceRecord): DreamTraceRecord {
  const isNoOp =
    typeof record.isNoOp === "boolean"
      ? record.isNoOp
      : record.status !== "error" &&
        record.outcome.deletedFiles === 0 &&
        record.outcome.rewrittenProjects === 0 &&
        !record.outcome.profileUpdated;
  const displayStatus =
    typeof record.displayStatus === "string" && record.displayStatus.trim()
      ? record.displayStatus
      : record.status === "error"
        ? "Error"
        : isNoOp
          ? "No-op"
          : record.status === "running"
            ? "Running"
            : "Completed";
  return {
    ...record,
    isNoOp,
    displayStatus,
  };
}

function sanitizeDreamStatus(value: unknown): DreamPipelineStatus | undefined {
  return value === "running" || value === "success" || value === "skipped" || value === "failed" ? value : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function sanitizeIndexingSettings(input: unknown, defaults: IndexingSettings): IndexingSettings {
  const record = isRecord(input) ? input : {};
  return {
    reasoningMode: record.reasoningMode === "accuracy_first" ? "accuracy_first" : defaults.reasoningMode,
    autoIndexIntervalMinutes: clampInt(record.autoIndexIntervalMinutes, defaults.autoIndexIntervalMinutes, 0, 10_080),
    autoDreamIntervalMinutes: clampInt(record.autoDreamIntervalMinutes, defaults.autoDreamIntervalMinutes, 0, 10_080),
  };
}

function normalizeSnapshotRelativePath(value: unknown, index: number): string {
  const raw = normalizeString(value).trim().replace(/\\/g, "/");
  if (!raw) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  if (isAbsolute(raw)) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === "." || segment === "..")) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  return segments.join("/");
}

function normalizeSnapshotFileRecord(value: unknown, index: number): MemorySnapshotFileRecord {
  if (!isRecord(value)) throw new MemoryBundleValidationError(`Invalid files[${index}]`);
  if (typeof value.content !== "string") {
    throw new MemoryBundleValidationError(`Invalid files[${index}].content`);
  }
  return {
    relativePath: normalizeSnapshotRelativePath(value.relativePath, index),
    content: value.content,
  };
}

function hasLegacyMultiProjectPath(relativePath: string): boolean {
  return relativePath.startsWith("projects/") || relativePath.includes("/project.meta.md");
}

function normalizeMemoryBundle(value: unknown): MemoryImportableBundle {
  if (!isRecord(value)) throw new MemoryBundleValidationError("Invalid memory bundle");
  const scope = normalizeString(typeof value.scope === "string" ? value.scope : undefined);
  if (scope && scope !== "current_project") {
    throw new MemoryBundleValidationError("Unsupported memory bundle scope. Expected current_project.");
  }
  const metadata = {
    exportedAt: normalizeString(value.exportedAt).trim() || nowIso(),
    ...(typeof value.lastIndexedAt === "string" && value.lastIndexedAt.trim()
      ? { lastIndexedAt: value.lastIndexedAt.trim() }
      : {}),
    ...(typeof value.lastDreamAt === "string" && value.lastDreamAt.trim()
      ? { lastDreamAt: value.lastDreamAt.trim() }
      : {}),
    ...(sanitizeDreamStatus(value.lastDreamStatus)
      ? { lastDreamStatus: sanitizeDreamStatus(value.lastDreamStatus)! }
      : {}),
    ...(typeof value.lastDreamSummary === "string" && value.lastDreamSummary.trim()
      ? { lastDreamSummary: value.lastDreamSummary.trim() }
      : {}),
    ...(sanitizeTraceArray<CaseTraceRecord>(value.recentCaseTraces, "caseId", "startedAt").length > 0
      ? { recentCaseTraces: sanitizeTraceArray<CaseTraceRecord>(value.recentCaseTraces, "caseId", "startedAt") }
      : {}),
    ...(sanitizeTraceArray<IndexTraceRecord>(value.recentIndexTraces, "indexTraceId", "startedAt").length > 0
      ? {
          recentIndexTraces: sanitizeTraceArray<IndexTraceRecord>(value.recentIndexTraces, "indexTraceId", "startedAt"),
        }
      : {}),
    ...(sanitizeTraceArray<DreamTraceRecord>(value.recentDreamTraces, "dreamTraceId", "startedAt").length > 0
      ? {
          recentDreamTraces: sanitizeTraceArray<DreamTraceRecord>(value.recentDreamTraces, "dreamTraceId", "startedAt"),
        }
      : {}),
  };
  if (value.formatVersion === MEMORY_EXPORT_FORMAT_VERSION) {
    if (!Array.isArray(value.files)) {
      throw new MemoryBundleValidationError("Invalid memory snapshot bundle files");
    }
    const files = value.files.map((item, index) => normalizeSnapshotFileRecord(item, index));
    const seenPaths = new Set<string>();
    for (const record of files) {
      if (seenPaths.has(record.relativePath)) {
        throw new MemoryBundleValidationError(`Duplicate imported snapshot file path: ${record.relativePath}`);
      }
      seenPaths.add(record.relativePath);
      if (hasLegacyMultiProjectPath(record.relativePath)) {
        throw new MemoryBundleValidationError(
          "Legacy multi-project memory bundles are not supported in current-project memory mode",
        );
      }
    }
    return {
      formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
      scope: "current_project",
      ...metadata,
      files,
    };
  }
  throw new MemoryBundleValidationError(
    `Unsupported memory bundle formatVersion. Expected ${MEMORY_EXPORT_FORMAT_VERSION}.`,
  );
}

function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function isGlobalRelativePath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath).startsWith(GLOBAL_MEMORY_PREFIX);
}

function toExposedGlobalRelativePath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith(GLOBAL_MEMORY_PREFIX) ? normalized : `${GLOBAL_MEMORY_PREFIX}${normalized}`;
}

function toInternalGlobalRelativePath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith(GLOBAL_MEMORY_PREFIX) ? normalized.slice(GLOBAL_MEMORY_PREFIX.length) : normalized;
}

function sortManifestEntries(entries: MemoryManifestEntry[]): MemoryManifestEntry[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function createSiblingTempPath(targetDir: string, label: string): string {
  const parentDir = dirname(targetDir);
  return join(
    parentDir,
    `.${basename(targetDir)}.${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

/**
 * Attempt `renameSync`; on Windows EPERM/EACCES (file-locking by indexer,
 * antivirus, or watchers), fall back to recursive copy + delete.
 */
function robustRenameSync(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
}

function sortSnapshotFiles(files: readonly MemorySnapshotFileRecord[]): MemorySnapshotFileRecord[] {
  return [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function snapshotVersionFromFiles(files: readonly MemorySnapshotFileRecord[]): string {
  return hashText(JSON.stringify(sortSnapshotFiles(files.filter(file => file.relativePath !== "MEMORY.md"))));
}

function readSnapshotFiles(rootDir: string): MemorySnapshotFileRecord[] {
  if (!existsSync(rootDir)) return [];
  const files: MemorySnapshotFileRecord[] = [];
  const walk = (currentDir: string) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        relativePath: relative(rootDir, absolutePath).replace(/\\/g, "/"),
        content: readFileSync(absolutePath, "utf8"),
      });
    }
  };
  walk(rootDir);
  return files;
}

export {
  clampInt,
  createSiblingTempPath,
  hasLegacyMultiProjectPath,
  isGlobalRelativePath,
  isPathWithinRoot,
  isRecord,
  normalizeIndexTraceRecord,
  normalizeL0Row,
  normalizeMemoryBundle,
  normalizeMessages,
  normalizeRelativePath,
  normalizeSnapshotFileRecord,
  normalizeSnapshotRelativePath,
  normalizeString,
  normalizeDreamTraceRecord,
  parseJson,
  readSnapshotFiles,
  robustRenameSync,
  sanitizeDreamStatus,
  sanitizeIndexingSettings,
  sanitizeTraceArray,
  snapshotVersionFromFiles,
  sortManifestEntries,
  sortSnapshotFiles,
  toExposedGlobalRelativePath,
  toInternalGlobalRelativePath,
};
