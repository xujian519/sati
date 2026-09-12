/**
 * Skill bundle 校验（磁盘 + manifest 两条路径）。
 *
 * 2026-09-11 由 `SkillManager.ts` 抽出（issue #152 / TD-EXTENSION-N01·N02：消除
 * 巨型类文件与双校验流程重复），实现逐字迁移，行为不变。
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { parseSkillFrontmatterWithMeta } from "./frontmatter.js";
import type { SkillValidationIssue, SkillValidationResult } from "./types.js";

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const RISKY_EXTS = new Set([".sh", ".bash", ".zsh", ".fish", ".exe", ".bat", ".cmd", ".dll", ".so", ".dylib"]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function pushIssue(arr: SkillValidationIssue[], code: string, message: string): void {
  arr.push({ code, message });
}

function validateRequiredFrontmatter(
  skillMdContent: string,
  hardFails: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): Record<string, unknown> | null {
  if (typeof skillMdContent !== "string" || !skillMdContent.trim()) {
    pushIssue(hardFails, "no_skill_md", "SKILL.md is empty or missing.");
    return null;
  }
  const parsed = parseSkillFrontmatterWithMeta(skillMdContent);
  const fm = parsed.frontmatter;
  if (Object.keys(fm).length === 0 && !skillMdContent.startsWith("---")) {
    pushIssue(hardFails, "frontmatter_missing", "SKILL.md does not start with a YAML frontmatter block.");
    return fm;
  }
  if (parsed.usedCompatibilityFallback) {
    pushIssue(
      warnings,
      "frontmatter_compat_fallback",
      "Frontmatter was parsed with compatibility fallback; consider standard YAML formatting.",
    );
  }
  if (typeof fm.name !== "string" || !fm.name.trim()) {
    pushIssue(hardFails, "frontmatter_missing_name", "Frontmatter is missing required field: name.");
  }
  if (typeof fm.description !== "string" || !fm.description.trim()) {
    pushIssue(
      hardFails,
      "frontmatter_missing_description",
      "Frontmatter is missing required field: description (skill won't surface in the slash menu without it).",
    );
  } else {
    const desc = fm.description.trim();
    if (desc.length < 20) {
      pushIssue(
        warnings,
        "description_short",
        `Description is short (${desc.length} chars). Consider expanding for better discovery.`,
      );
    }
    if (desc.length > 1024) {
      pushIssue(
        warnings,
        "description_long",
        `Description is very long (${desc.length} chars). Most slash-menu surfaces truncate this.`,
      );
    }
  }
  return fm;
}

export async function validateFromDisk(sourcePath: string): Promise<SkillValidationResult> {
  const hardFails: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const stats = { fileCount: 0, totalBytes: 0 };
  let frontmatter: Record<string, unknown> | null = null;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    // 源路径不可 stat（不存在/不可读）→ 记 source_missing 硬失败并中止校验。
    pushIssue(hardFails, "source_missing", `Source path does not exist: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  if (!stat.isDirectory()) {
    pushIssue(hardFails, "source_not_directory", `Source path is not a directory: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }

  let skillMdContent = "";
  try {
    skillMdContent = await fs.readFile(join(sourcePath, "SKILL.md"), "utf8");
  } catch {
    // SKILL.md 缺失/不可读 → 记 no_skill_md 硬失败并中止校验。
    pushIssue(hardFails, "no_skill_md", "Source folder does not contain a SKILL.md at the root.");
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);

  await walkDir(sourcePath, "", stats, hardFails, warnings);

  pushBundleLimitIssues(stats, hardFails);

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}

async function walkDir(
  dir: string,
  relPrefix: string,
  stats: { fileCount: number; totalBytes: number },
  hardFails: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // readdir 失败 → 跳过本层文件统计，仅影响 fileCount/totalBytes 展示（best-effort）。
    return;
  }
  for (const entry of entries) {
    if (stats.fileCount > MAX_FILE_COUNT) return;
    const rel = posix.join(relPrefix, entry.name);
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      pushIssue(warnings, "contains_symlink", `Bundle contains a symlink: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(abs, rel, stats, hardFails, warnings);
      continue;
    }
    stats.fileCount += 1;
    try {
      const fileStat = await fs.stat(abs);
      stats.totalBytes += fileStat.size;
      pushFileSizeIssues(fileStat.size, rel, hardFails, warnings);
    } catch {
      // 单文件不可读：跳过其体积统计，仅影响 file_too_large/large 告警判定（best-effort）。
    }
    const ext = extOf(entry.name).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      pushIssue(warnings, "risky_extension", `Executable-style file (${ext}): ${rel}`);
    }
  }
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx);
}

export function validateFromManifest(
  skillMdContent: string,
  files: Array<{ relativePath: string; size: number }>,
): SkillValidationResult {
  const hardFails: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const stats = { fileCount: 0, totalBytes: 0 };

  let hasSkillMd = false;
  for (const f of files) {
    const rel = typeof f.relativePath === "string" ? f.relativePath : null;
    if (!rel) continue;
    if (rel === "SKILL.md") hasSkillMd = true;
    if (rel.includes("..") || isAbsolute(rel)) {
      pushIssue(hardFails, "unsafe_path", `File path is unsafe: ${rel}`);
      continue;
    }
    const size = Number(f.size) || 0;
    stats.fileCount += 1;
    stats.totalBytes += size;
    pushFileSizeIssues(size, rel, hardFails, warnings);
    const ext = extOf(rel).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      pushIssue(warnings, "risky_extension", `Executable-style file (${ext}): ${rel}`);
    }
  }
  if (!hasSkillMd) {
    pushIssue(hardFails, "no_skill_md", "No SKILL.md at the root of the picked folder.");
  }
  pushBundleLimitIssues(stats, hardFails);

  let frontmatter: Record<string, unknown> | null = null;
  if (hasSkillMd) {
    frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);
  }

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}

/** Bundle 规模硬限（文件数 / 总字节），磁盘与 manifest 两条校验路径共用。 */
function pushBundleLimitIssues(
  stats: { fileCount: number; totalBytes: number },
  hardFails: SkillValidationIssue[],
): void {
  if (stats.fileCount > MAX_FILE_COUNT) {
    pushIssue(hardFails, "too_many_files", `Bundle has more than ${MAX_FILE_COUNT} files.`);
  }
  if (stats.totalBytes > MAX_TOTAL_BYTES) {
    pushIssue(
      hardFails,
      "total_too_large",
      `Bundle total size exceeds ${MAX_TOTAL_BYTES} bytes (${stats.totalBytes}).`,
    );
  }
}

/** 单文件体积硬限/告警，磁盘与 manifest 两条校验路径共用（文案逐字一致）。 */
function pushFileSizeIssues(
  size: number,
  rel: string,
  hardFails: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): void {
  if (size > MAX_FILE_BYTES) {
    pushIssue(hardFails, "file_too_large", `File exceeds ${MAX_FILE_BYTES} bytes: ${rel} (${size} bytes)`);
  } else if (size > 1024 * 1024) {
    pushIssue(warnings, "file_large", `Large file: ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}
