import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** P2-03：MANIFEST 文件名（<outputDir>/.MANIFEST.jsonl，append 追加式）。 */
const MANIFEST_FILE = ".MANIFEST.jsonl";

/** P2-03：MANIFEST 条目——每行一个 JSON，字段与 Python 侧契约一致。 */
export type PatentManifestEntry = {
  patent: string;
  status: "ok" | "failed";
  path?: string;
  size?: number;
  sha1?: string;
  ts: number;
};

/** P2-03：磁盘文件大小与 MANIFEST 记录一致才算命中续传（不存在/异常视为不匹配）。 */
export async function fileSizeMatches(path: string, expectedSize: number): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.size === expectedSize;
  } catch {
    return false;
  }
}

/**
 * P2-03：加载 MANIFEST。按 patent 键去重（append 式积累的重复行最后一条 wins）；
 * 损坏行容忍跳过（仅影响该条目的续传），文件不存在返回空。
 */
export async function loadManifest(outputDir: string): Promise<Map<string, PatentManifestEntry>> {
  const manifestPath = join(outputDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const byPatent = new Map<string, PatentManifestEntry>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as PatentManifestEntry;
      if (entry && typeof entry.patent === "string" && entry.status === "ok") {
        byPatent.set(entry.patent, entry);
      }
    } catch {
      // 单行损坏：跳过该行，其余行仍生效
    }
  }
  return byPatent;
}

/** P2-03：追加一条 MANIFEST 记录（成功后调用；--force 不清除历史，靠去重忽略旧行）。 */
export async function saveManifestEntry(outputDir: string, entry: PatentManifestEntry): Promise<void> {
  const manifestPath = join(outputDir, MANIFEST_FILE);
  await appendFile(manifestPath, JSON.stringify(entry) + "\n", "utf8");
}

/** P2-03：计算文件 SHA-1（写 MANIFEST 用；跳过判定只看 size，不读全文）。 */
export async function sha1OfFile(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha1").update(data).digest("hex");
}
