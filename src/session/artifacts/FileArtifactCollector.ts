import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolResult } from "../../tool/index.js";
import type {
  FileArtifact,
  FileArtifactOperation,
  FileArtifactSource,
  FileArtifactStatus,
} from "./FileArtifact.js";

type FileFingerprint = {
  size: number;
  mtimeMs: number;
};

type ArtifactCandidate = {
  absolutePath: string;
  source: FileArtifactSource;
  allowUnsupported?: boolean;
};

export type FileArtifactCollectorOptions = {
  cwd: string;
  allowedInputPaths?: string[];
  now?: () => Date;
};

const FALLBACK_EXTENSIONS = new Set([
  ".csv", ".doc", ".docx", ".dps", ".et", ".gif", ".htm", ".html",
  ".jpeg", ".jpg", ".json", ".md", ".odt", ".ods", ".odp", ".pdf",
  ".png", ".ppt", ".pptx", ".rtf", ".svg", ".tex", ".tsv", ".txt",
  ".webp", ".wps", ".xls", ".xlsx", ".xml", ".zip",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".pilotdeck",
  ".cache",
  ".idea",
  ".vscode",
  "build",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "qa",
  "screenshots",
  "temp",
  "tmp",
]);

const INTERNAL_FILE_PATTERNS = [
  /^\.pilotdeck_build\.(?:c|m)?js$/i,
  /^audit(?:[-_.].*)?\.json$/i,
  /^slides?_test(?:[-_.].*)?\.(?:json|png)$/i,
  /^(?:render|preview)[-_]?slides?[-_.]\d+\.png$/i,
  /^(?:qa|debug|trace|tool[-_]?result|coverage)(?:[-_.].*)?$/i,
];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dps": "application/vnd.ms-powerpoint",
  ".et": "application/vnd.ms-excel",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".wps": "application/vnd.ms-works",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export class FileArtifactCollector {
  private readonly cwd: string;
  private readonly now: () => Date;
  private readonly baseline = new Map<string, FileFingerprint>();
  private readonly explicitCandidates = new Map<string, ArtifactCandidate>();
  private readonly allowedInputPaths: Set<string>;

  private constructor(options: FileArtifactCollectorOptions) {
    this.cwd = path.resolve(options.cwd);
    this.now = options.now ?? (() => new Date());
    this.allowedInputPaths = new Set(
      (options.allowedInputPaths ?? [])
        .map((inputPath) => path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(this.cwd, inputPath))
        .filter((inputPath) => isWithin(this.cwd, inputPath) && !isHardInternalPath(this.cwd, inputPath)),
    );
  }

  static async start(options: FileArtifactCollectorOptions): Promise<FileArtifactCollector> {
    const collector = new FileArtifactCollector(options);
    collector.baseline.clear();
    for (const file of await collector.scanWorkspace()) {
      collector.baseline.set(file.absolutePath, file.fingerprint);
    }
    await collector.captureAllowedInputFingerprints(collector.baseline);
    return collector;
  }

  observeToolResult(result: PilotDeckToolResult): void {
    if (result.type !== "success") return;

    for (const item of result.content) {
      if (item.type === "file") {
        this.addExplicitPath(item.path, true);
      }
    }

    if (["write_file", "edit_file", "edit_notebook"].includes(result.toolName)) {
      collectKnownFilePaths(result.data, (candidate) => this.addExplicitPath(candidate, false));
    }
  }

  async finish(status: FileArtifactStatus): Promise<FileArtifact[]> {
    const candidates = new Map<string, ArtifactCandidate>(this.explicitCandidates);
    for (const file of await this.scanWorkspace()) {
      const before = this.baseline.get(file.absolutePath);
      if (!before || before.size !== file.fingerprint.size || before.mtimeMs !== file.fingerprint.mtimeMs) {
        candidates.set(file.absolutePath, {
          absolutePath: file.absolutePath,
          source: candidates.get(file.absolutePath)?.source ?? "workspace_diff",
        });
      }
    }
    const allowedInputFinal = new Map<string, FileFingerprint>();
    await this.captureAllowedInputFingerprints(allowedInputFinal);
    for (const [absolutePath, fingerprint] of allowedInputFinal) {
      const before = this.baseline.get(absolutePath);
      if (!before || before.size !== fingerprint.size || before.mtimeMs !== fingerprint.mtimeMs) {
        candidates.set(absolutePath, {
          absolutePath,
          source: candidates.get(absolutePath)?.source ?? "workspace_diff",
          allowUnsupported: true,
        });
      }
    }

    const artifacts: FileArtifact[] = [];
    for (const candidate of candidates.values()) {
      const artifact = await this.materialize(candidate, status);
      if (artifact) artifacts.push(artifact);
    }

    return artifacts.sort((left, right) => left.path.localeCompare(right.path));
  }

  private addExplicitPath(candidate: string, allowUnsupported: boolean): void {
    const absolutePath = path.resolve(this.cwd, candidate);
    if (!isWithin(this.cwd, absolutePath) || !this.isAllowedArtifactPath(absolutePath)) return;
    if (!allowUnsupported && !isFallbackArtifactPath(this.cwd, absolutePath)) return;
    this.explicitCandidates.set(absolutePath, { absolutePath, source: "tool", allowUnsupported });
  }

  private async scanWorkspace(): Promise<Array<{ absolutePath: string; fingerprint: FileFingerprint }>> {
    const files: Array<{ absolutePath: string; fingerprint: FileFingerprint }> = [];
    await walk(this.cwd, async (absolutePath) => {
      if (!isFallbackArtifactPath(this.cwd, absolutePath)) return;
      const fileStat = await stat(absolutePath).catch(() => undefined);
      if (!fileStat?.isFile()) return;
      files.push({
        absolutePath,
        fingerprint: { size: fileStat.size, mtimeMs: fileStat.mtimeMs },
      });
    });
    return files;
  }

  private async captureAllowedInputFingerprints(target: Map<string, FileFingerprint>): Promise<void> {
    for (const absolutePath of this.allowedInputPaths) {
      const fileStat = await stat(absolutePath).catch(() => undefined);
      if (!fileStat?.isFile()) continue;
      target.set(absolutePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs });
    }
  }

  private async materialize(
    candidate: ArtifactCandidate,
    statusValue: FileArtifactStatus,
  ): Promise<FileArtifact | undefined> {
    if (!isWithin(this.cwd, candidate.absolutePath) || !this.isAllowedArtifactPath(candidate.absolutePath)) {
      return undefined;
    }
    const fileStat = await stat(candidate.absolutePath).catch(() => undefined);
    if (!fileStat?.isFile()) return undefined;

    const relativePath = normalizeRelativePath(path.relative(this.cwd, candidate.absolutePath));
    if (!relativePath) return undefined;
    const before = this.baseline.get(candidate.absolutePath);
    if (
      before &&
      before.size === fileStat.size &&
      before.mtimeMs === fileStat.mtimeMs
    ) {
      return undefined;
    }
    if (!candidate.allowUnsupported && !FALLBACK_EXTENSIONS.has(path.extname(candidate.absolutePath).toLowerCase())) {
      return undefined;
    }
    const operation: FileArtifactOperation = before ? "updated" : "created";
    const sha256 = await sha256File(candidate.absolutePath).catch(() => undefined);
    if (!sha256) return undefined;

    return {
      id: createHash("sha256").update(`${relativePath}\0${sha256}`).digest("hex").slice(0, 24),
      name: path.basename(candidate.absolutePath),
      path: relativePath,
      operation,
      source: candidate.source,
      status: statusValue,
      size: fileStat.size,
      sha256,
      ...(mimeTypeForPath(candidate.absolutePath) ? { mimeType: mimeTypeForPath(candidate.absolutePath) } : {}),
      createdAt: this.now().toISOString(),
    };
  }

  private isAllowedArtifactPath(absolutePath: string): boolean {
    if (isHardInternalPath(this.cwd, absolutePath)) return false;
    if (!isInternalPath(this.cwd, absolutePath)) return true;
    return this.allowedInputPaths.has(absolutePath);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walk(root: string, visit: (absolutePath: string) => Promise<void>): Promise<void> {
  const directory = await opendir(root).catch(() => undefined);
  if (!directory) return;
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) continue;
      await walk(absolutePath, visit);
      continue;
    }
    if (entry.isFile()) await visit(absolutePath);
  }
}

function isFallbackArtifactPath(root: string, absolutePath: string): boolean {
  if (isInternalPath(root, absolutePath)) return false;
  return FALLBACK_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

function isInternalPath(root: string, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relativePath) return true;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.startsWith(".") || EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    return true;
  }
  return INTERNAL_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(relativePath)));
}

function isHardInternalPath(root: string, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relativePath) return true;
  const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
  return segments.some((segment) => segment === ".pilotdeck" || segment === ".git" || segment === "node_modules")
    || /^\.pilotdeck_build\.(?:c|m)?js$/i.test(path.basename(relativePath));
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function mimeTypeForPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function collectKnownFilePaths(value: unknown, add: (pathValue: string) => void, depth = 0): void {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnownFilePaths(item, add, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string" &&
      /^(?:filePath|outputFile|outputPath|artifactPath)$/i.test(key)
    ) {
      add(child);
      continue;
    }
    collectKnownFilePaths(child, add, depth + 1);
  }
}
