/**
 * 项目级 hook 信任存储：`<pilotHome>/hook-trust.json`。
 *
 * 为什么单独落盘而不写 `sati.yaml`：`src/` 内没有 sati.yaml 写通道，且信任是
 * **运行时事实**（授权对象是「某次看到的那个内容摘要」），与用户配置混写会让
 * 「用户改了什么」不可辨认——同 `src/model/window/store.ts` 的理由。
 *
 * 读路径 fail-closed：文件缺失/损坏/版本未知一律按空表处理 → 所有项目插件回到
 * `pending`（须重新评审），绝不因存储坏了而把未评审的声明当已授权。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../../../patent/persist-utils.js";
import { HOOK_TRUST_STORE_VERSION, type HookTrustFile, type HookTrustRecord } from "./protocol.js";

export const HOOK_TRUST_STORE_FILENAME = "hook-trust.json";

export function hookTrustStorePath(pilotHome: string): string {
  return join(pilotHome, HOOK_TRUST_STORE_FILENAME);
}

/** 记录键：工作区身份 + 插件身份（同一插件在两个项目里的授权互不影响）。 */
export function hookTrustKey(workspaceIdentityKey: string, pluginId: string): string {
  return `${workspaceIdentityKey}|${pluginId}`;
}

function emptyFile(): HookTrustFile {
  return { version: HOOK_TRUST_STORE_VERSION, entries: {} };
}

function sanitizeRecord(raw: unknown): HookTrustRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.decision !== "granted" && record.decision !== "revoked") return undefined;
  if (typeof record.pluginId !== "string" || typeof record.digest !== "string") return undefined;
  return {
    pluginId: record.pluginId,
    decision: record.decision,
    digest: record.digest,
    grantedAt: typeof record.grantedAt === "string" ? record.grantedAt : new Date(0).toISOString(),
    sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : "",
  };
}

/** 解析存储正文（容错：任何异常/未知版本 → 空表）。 */
export function parseHookTrustFile(raw: string): HookTrustFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyFile();
  const file = parsed as Record<string, unknown>;
  if (file.version !== HOOK_TRUST_STORE_VERSION) return emptyFile();
  if (typeof file.entries !== "object" || file.entries === null || Array.isArray(file.entries)) return emptyFile();
  const entries: Record<string, HookTrustRecord> = {};
  for (const [key, value] of Object.entries(file.entries as Record<string, unknown>)) {
    const record = sanitizeRecord(value);
    if (record) entries[key] = record;
  }
  return { version: HOOK_TRUST_STORE_VERSION, entries };
}

export class HookTrustStore {
  constructor(private readonly filePath: string) {}

  /** 同步读取整表；文件缺失/损坏 → 空表。 */
  read(): HookTrustFile {
    try {
      return parseHookTrustFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return emptyFile();
    }
  }

  /**
   * 写入一条决定（同键覆盖）。写路径按「先读整表 → 覆盖该键 → 原子写」进行：
   * 信任表的写入频率是人工点击级，无需并发合并；原子写保证不会留下半截文件
   * （半截文件在下次读取时按空表处理，等于丢掉全部授权——代价是重新评审，
   * 而不是误授权）。撤销同样走本方法（写 `decision: "revoked"`）：保留「用户曾
   * 明确拒绝过这一份内容」的记录，比删掉后与「从未评审」不可分辨更有用。
   */
  async record(workspaceIdentityKey: string, record: HookTrustRecord): Promise<HookTrustRecord> {
    const file = this.read();
    const key = hookTrustKey(workspaceIdentityKey, record.pluginId);
    const next: HookTrustFile = {
      version: HOOK_TRUST_STORE_VERSION,
      entries: { ...file.entries, [key]: record },
    };
    await this.writeFile(next);
    return record;
  }

  private async writeFile(file: HookTrustFile): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    await atomicWriteJson(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}
