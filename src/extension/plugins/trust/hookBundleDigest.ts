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
 *
 * 两条入口，**安全边界不同，不可混用**（#538）：
 * - `computeHookBundleDigest`：纯内容哈希，**无缓存**。强制路径（会话装配装载
 *   `retainTrustedHookMatchers`、授权 `hookTrustService.decide`）必须用它——信任判据
 *   要求「当前磁盘内容」，任何陈旧摘要都会让被改过的 hook 蒙混装载。
 * - `computeHookBundleDigestForReport`：进程内 memo，按 walk 签名 `(rel+size+mtimeMs)`
 *   失效，跳过昂贵的 `readFile`+逐字节哈希。**只**用于报告/面板的**可见性**路径
 *   （`hookTrustService.list`）。签名不含内容，故「内容变但 size 与 mtime 都被回填」会
 *   命中陈旧摘要——这在可见性路径上至多让横幅显示一次过期状态（下一次 mtime 真实变化
 *   即纠正），但**绝不能**喂给强制路径（见上）。这正是 `hookBundleDigest` 头部「mtime
 *   不是信任判据」取舍的延续：memo 是性能优化，不是信任判据。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SatiPluginManifest } from "../protocol/manifest.js";

/** 哈希上限：防止插件目录里塞进大资产树后每次装配都做无谓全量读盘。 */
export const HOOK_BUNDLE_MAX_FILES = 2000;
export const HOOK_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `blocked` 的结构化原因（#538）：面板据此给出**不同**的人工处置提示。
 * - `over_limit`：目录超出哈希上限（文件数 / 字节数）⇒ 摘要算不动，须瘦身插件目录。
 * - `unsafe_content`：内容无法被安全哈希（声明越界 / 符号链接 / 非普通文件 / 读盘失败）
 *   ⇒ 须人工评审目录内容。
 */
export type HookBundleBlockedReason = "over_limit" | "unsafe_content";

export type HookBundleDigest =
  | { kind: "hashed"; digest: string; fileCount: number; bytes: number }
  | { kind: "blocked"; reason: HookBundleBlockedReason; detail: string };

/** 摘要计算入口的统一签名（强制路径与报告路径可互换注入，见 `evaluateProjectHookTrust`）。 */
export type HookBundleDigestComputer = (pluginRoot: string, manifest: SatiPluginManifest) => Promise<HookBundleDigest>;

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

type CollectedFile = { relative: string; absolute: string; size: number; mtimeMs: number };

type WalkResult =
  | { kind: "walked"; files: CollectedFile[]; bytes: number }
  | { kind: "blocked"; reason: HookBundleBlockedReason; detail: string };

/**
 * 遍历插件目录树，产出待哈希的文件清单（含每个文件的 `size`/`mtimeMs`，供报告路径的
 * memo 签名复用——不额外增加 IO，stat 本就要做）。任何无法安全遍历的形态都 `blocked`。
 */
async function walkBundle(pluginRoot: string, manifest: SatiPluginManifest): Promise<WalkResult> {
  const escape = hooksDeclarationEscapes(pluginRoot, manifest);
  if (escape !== undefined) {
    return { kind: "blocked", reason: "unsafe_content", detail: escape };
  }
  const root = resolve(pluginRoot);
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
      // 失败模式：目录不可读（权限不足 / 遍历途中被删）。回退语义：blocked
      // （unsafe_content）——拿不到完整树就无法建立可信摘要，fail-closed 不静默通过。
      return {
        kind: "blocked",
        reason: "unsafe_content",
        detail: `cannot read ${relativeDir === "" ? "the plugin directory" : relativeDir}`,
      };
    }
    for (const entry of entries) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      // 链接可指向树外目标：跟随会哈希到本次声明之外的内容，跳过则漏掉被执行的脚本。
      if (entry.isSymbolicLink()) {
        return {
          kind: "blocked",
          reason: "unsafe_content",
          detail: `plugin directory contains a symbolic link (${relativePath})`,
        };
      }
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        return {
          kind: "blocked",
          reason: "unsafe_content",
          detail: `plugin directory contains a non-regular file (${relativePath})`,
        };
      }
      const stats = await stat(join(root, relativePath)).catch(() => null);
      // 失败模式：stat 竞态失败（文件在 readdir 与 stat 之间被删）。回退语义：null →
      // blocked（unsafe_content），与「算不出来就说算不出来」一致。
      if (stats === null) {
        return {
          kind: "blocked",
          reason: "unsafe_content",
          detail: `cannot stat ${relativePath} inside the plugin directory`,
        };
      }
      bytes += stats.size;
      if (files.length + 1 > HOOK_BUNDLE_MAX_FILES || bytes > HOOK_BUNDLE_MAX_BYTES) {
        return {
          kind: "blocked",
          reason: "over_limit",
          detail: `plugin directory exceeds the content-hash limits (${HOOK_BUNDLE_MAX_FILES} files / ${HOOK_BUNDLE_MAX_BYTES} bytes)`,
        };
      }
      files.push({
        relative: relativePath,
        absolute: join(root, relativePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }
  // 排序保证哈希与 readdir 顺序无关（不同文件系统的返回序不同）。
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return { kind: "walked", files, bytes };
}

type HashResult =
  | { kind: "hashed"; digest: string; fileCount: number; bytes: number }
  | { kind: "blocked"; reason: HookBundleBlockedReason; detail: string };

/** 逐字节哈希已遍历的文件清单（昂贵的一步：readFile 全部内容）。 */
async function hashFiles(files: CollectedFile[]): Promise<HashResult> {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readFile(file.absolute);
    } catch {
      // 失败模式：文件在 walk 与 read 之间被删 / 权限变化。回退语义：blocked
      // （unsafe_content）——半个树的摘要会给出虚假的可信，宁可不给。
      return {
        kind: "blocked",
        reason: "unsafe_content",
        detail: `cannot read ${file.relative} inside the plugin directory`,
      };
    }
    // 相对路径与内容都进哈希，并用 \0 分隔，避免「文件名+内容」拼接歧义。
    hash.update(file.relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    bytes += file.size;
  }
  return { kind: "hashed", digest: `sha256:${hash.digest("hex")}`, fileCount: files.length, bytes };
}

/**
 * 纯内容哈希，**无缓存**。强制路径（会话装配装载、授权决策）的唯一合法入口：信任判据
 * 必须是「当前磁盘内容」，不得复用任何可能陈旧的摘要。
 */
export async function computeHookBundleDigest(
  pluginRoot: string,
  manifest: SatiPluginManifest,
): Promise<HookBundleDigest> {
  const walked = await walkBundle(pluginRoot, manifest);
  if (walked.kind === "blocked") return walked;
  return hashFiles(walked.files);
}

/**
 * 报告/面板 memo：键 = 解析后的插件根，值 = `{ walk 签名, 摘要 }`。仅进程内、只存
 * `hashed` 结果（`blocked`/读盘失败不写缓存，否则一次瞬时 IO 抖动会把插件永久钉死成
 * blocked）。`clearHookBundleDigestCache` 供测试隔离与长进程手动失效。
 */
const reportDigestCache = new Map<string, { signature: string; digest: HookBundleDigest }>();

export function clearHookBundleDigestCache(): void {
  reportDigestCache.clear();
}

/** walk 签名：`(rel + size + mtimeMs)` 逐文件入 sha256。复用 walk 已做的 stat，零额外 IO。 */
function walkSignature(files: CollectedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * 报告/面板**可见性**路径专用的 memo 版摘要（#538）。第二次评估同一目录时，walk 签名
 * 未变即跳过 `readFile`+哈希，把 166–189ms 的全量读盘降为一次 readdir+stat。
 *
 * ⚠️ **不得**用于强制路径：签名不含内容，「内容变但 size 与 mtime 都被回填」会命中陈旧
 * 摘要。强制路径（装载 / 授权）必须用 `computeHookBundleDigest`。
 */
export async function computeHookBundleDigestForReport(
  pluginRoot: string,
  manifest: SatiPluginManifest,
): Promise<HookBundleDigest> {
  const walked = await walkBundle(pluginRoot, manifest);
  // blocked 不写缓存：可见性路径也要能在目录恢复后立即重新算出 hashed。
  if (walked.kind === "blocked") return walked;
  const cacheKey = resolve(pluginRoot);
  const signature = walkSignature(walked.files);
  const cached = reportDigestCache.get(cacheKey);
  if (cached !== undefined && cached.signature === signature) {
    return cached.digest;
  }
  const digest = await hashFiles(walked.files);
  // 只缓存 hashed：blocked/读盘失败是瞬时态，缓存下来会把插件钉死。
  if (digest.kind === "hashed") {
    reportDigestCache.set(cacheKey, { signature, digest });
  }
  return digest;
}
