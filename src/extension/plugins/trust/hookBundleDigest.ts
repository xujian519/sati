/**
 * 插件目录的内容摘要（信任门的判据）。
 *
 * 三个刻意的取舍：
 * - **不复用 `PluginRuntime` 的插件指纹**：那是 `mtimeMs + size` 拼串，`git clone` /
 *   `checkout` / `rsync` 会重写 mtime（指纹变而内容没变），`touch` 也能伪造变更。
 *   信任判据必须是逐字节内容哈希。
 * - **整棵目录树入哈希**：hook 的 `command` 可以引用插件目录内的脚本，只哈希声明文件
 *   会漏掉「声明没变、被执行的脚本换了」这一形态。
 * - **算不出来就说算不出来**：符号链接、非普通文件、超出上限、读取失败一律 `blocked`，
 *   不留静默通过路径（`blocked` 在报告期只是可见性，强制期等同「须人工评审」）。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SatiPluginManifest } from "../protocol/manifest.js";

/** 哈希上限：防止插件目录里塞进大资产树后每次装配都做无谓全量读盘。 */
export const HOOK_BUNDLE_MAX_FILES = 2000;
export const HOOK_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

export type HookBundleDigest =
  | { kind: "hashed"; digest: string; fileCount: number; bytes: number }
  | { kind: "blocked"; detail: string };

/**
 * `manifest.hooks` 为字符串时是**相对插件目录**的路径（`PluginLoader.loadHooksConfig` 的
 * 解析口径）。指向目录之外的文件意味着「被执行的声明不在被哈希的树里」——摘要会给出
 * 虚假的可信，故直接 blocked。
 */
function hooksDeclarationEscapes(pluginRoot: string, manifest: SatiPluginManifest): string | undefined {
  if (typeof manifest.hooks !== "string") return undefined;
  const root = resolve(pluginRoot);
  const declared = resolve(root, manifest.hooks);
  const rel = relative(root, declared);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `hooks declaration resolves outside the plugin directory: ${manifest.hooks}`;
  }
  return undefined;
}

export async function computeHookBundleDigest(
  pluginRoot: string,
  manifest: SatiPluginManifest,
): Promise<HookBundleDigest> {
  const escape = hooksDeclarationEscapes(pluginRoot, manifest);
  if (escape !== undefined) {
    return { kind: "blocked", detail: escape };
  }
  const collected = await collectFiles(resolve(pluginRoot));
  if (!("files" in collected)) {
    return { kind: "blocked", detail: collected.detail };
  }
  const hash = createHash("sha256");
  for (const file of collected.files) {
    let content: Buffer;
    try {
      content = await readFile(file.absolute);
    } catch {
      return { kind: "blocked", detail: `cannot read ${file.relative} inside the plugin directory` };
    }
    // 相对路径与内容都进哈希，并用 \0 分隔，避免「文件名+内容」拼接歧义。
    hash.update(file.relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return {
    kind: "hashed",
    digest: `sha256:${hash.digest("hex")}`,
    fileCount: collected.files.length,
    bytes: collected.bytes,
  };
}

type CollectedFile = { relative: string; absolute: string };

async function collectFiles(root: string): Promise<{ files: CollectedFile[]; bytes: number } | { detail: string }> {
  const files: CollectedFile[] = [];
  let bytes = 0;
  const pending = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop() ?? "";
    const absoluteDir = relativeDir === "" ? root : join(root, relativeDir);
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return { detail: `cannot read ${relativeDir === "" ? "the plugin directory" : relativeDir}` };
    }
    for (const entry of entries) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      // 链接可指向树外目标：跟随会哈希到本次声明之外的内容，跳过则漏掉被执行的脚本。
      if (entry.isSymbolicLink()) {
        return { detail: `plugin directory contains a symbolic link (${relativePath})` };
      }
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        return { detail: `plugin directory contains a non-regular file (${relativePath})` };
      }
      const stats = await stat(join(root, relativePath)).catch(() => null);
      if (stats === null) {
        return { detail: `cannot stat ${relativePath} inside the plugin directory` };
      }
      bytes += stats.size;
      if (files.length + 1 > HOOK_BUNDLE_MAX_FILES || bytes > HOOK_BUNDLE_MAX_BYTES) {
        return {
          detail: `plugin directory exceeds the content-hash limits (${HOOK_BUNDLE_MAX_FILES} files / ${HOOK_BUNDLE_MAX_BYTES} bytes)`,
        };
      }
      files.push({ relative: relativePath, absolute: join(root, relativePath) });
    }
  }
  // 排序保证哈希与 readdir 顺序无关（不同文件系统的返回序不同）。
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return { files, bytes };
}
