/**
 * Snapshot —— 被进化对象（角色 SKILL.md）的版本快照（对齐 PenguinHarness snapshots/v<N>.tar.gz）。
 *
 * 语义约束：
 *   - 版本号只增不减、不重用：`v<N>` 目录已存在即拒绝，绝不覆盖用户的手动改动。
 *   - **密钥永不进快照**：`.vault.toml`、`.env`、凭据类文件（secret/credential/token/apiKey 等
 *     命名文件）一律排除，与"值只进子进程环境、永不进上下文"的约定一致。
 *   - 打包后写 `manifest.yaml` 记录 version/source/time/文件清单，供回滚与审计。
 */

import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/** 相对源目录的文件（不含被排除项）。 */
export type SnapshotFile = { abs: string; rel: string };

/** 打包结果。 */
export type SnapshotResult = {
  version: number;
  root: string;
  files: string[];
};

const SECRET_NAME_RE = /(secret|credential|token|api[_-]?key|private[_-]?key)/i;

/** 文件名级排除：密钥/凭据/环境文件，绝不进快照。 */
export function isExcludedSnapshotEntry(relPath: string): boolean {
  const base = basename(relPath);
  if (base === ".vault.toml") return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.pem$/i.test(base) || /\.key$/i.test(base) || /\.p12$/i.test(base)) return true;
  if (SECRET_NAME_RE.test(base)) return true;
  // 依赖目录与运行时产物不进快照。
  if (relPath.split(/[\\/]/).includes("node_modules")) return true;
  return false;
}

/** 递归收集源目录下未被排除的文件。 */
export async function collectSnapshotFiles(sourceDir: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      // 源目录缺失：由调用方提前校验存在性；此处按空处理（fail-closed 由调用方承担）。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(sourceDir, abs);
      if (isExcludedSnapshotEntry(rel)) continue;
      const info = await stat(abs);
      if (info.isDirectory()) {
        await walk(abs);
      } else {
        files.push({ abs, rel });
      }
    }
  }
  await walk(sourceDir);
  return files;
}

/**
 * 把源目录打包为 `<snapshotDir>/v<version>`。`v<version>` 已存在则拒绝（版本不覆盖）。
 * 返回包内文件相对清单。
 */
export async function packSnapshot(
  sourceDir: string,
  snapshotDir: string,
  version: number,
  now: () => Date = () => new Date(),
): Promise<SnapshotResult> {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`Snapshot version must be a positive integer; got ${version}.`);
  }
  const targetRoot = join(snapshotDir, `v${version}`);
  // 已存在 → 拒绝，绝不覆盖（版本只增不减、不重用）。
  let exists = false;
  try {
    await stat(targetRoot);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    throw new Error(`Snapshot version v${version} already exists at ${targetRoot}; refusing to overwrite.`);
  }

  const files = await collectSnapshotFiles(sourceDir);
  await mkdir(targetRoot, { recursive: true });
  const relPaths: string[] = [];
  for (const file of files) {
    const target = join(targetRoot, file.rel);
    await mkdir(join(targetRoot, dirnameOf(file.rel)), { recursive: true });
    await copyFile(file.abs, target);
    relPaths.push(file.rel);
  }

  const manifest = {
    version,
    source: sourceDir,
    created_at: now().toISOString(),
    files: relPaths,
  };
  await writeFile(join(targetRoot, "manifest.yaml"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { version, root: targetRoot, files: relPaths };
}

function dirnameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "." : relPath.slice(0, idx) || ".";
}
