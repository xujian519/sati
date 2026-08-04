/**
 * 持久化共享工具（workflow-store / flexible-plan-store 共用）。
 *
 * - assertSafeId：文件路径安全字符校验（防 `..` / 路径分隔符 / 隐藏文件写入）
 * - atomicWriteJson：原子写（先写同目录临时文件再 rename，避免中断/并发产生半写 JSON）
 * - JsonFileStore：每 id 一个 JSON 文件（`<dir>/<id>.json`）的通用单文件存储——
 *   save/load/list 三接口 + ENOENT 映射，parse 回调注入反序列化/校验
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

/** 安全 id 字符集：字母/数字/点/下划线/连字符，且不允许以点开头。 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验 id 可直接拼入文件路径；非法抛 RangeError（fail-closed）。 */
export function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new RangeError(
      `Invalid ${what} ${JSON.stringify(id)}: only [A-Za-z0-9._-] allowed and must not start with "."`,
    );
  }
}

/** 原子写 JSON：先写同目录临时文件再 rename（目录由调用方确保已存在）。 */
export async function atomicWriteJson(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

/**
 * 通用单文件 JSON 存储：每 id 一个 `<dir>/<id>.json` 文件。
 * save 先建目录再原子写；load 缺失（ENOENT）返回 undefined；listIds 只返回
 * 安全字符集的 id（过滤目录里的外来文件，避免 list→load 往返 RangeError）。
 */
export class JsonFileStore<T> {
  constructor(
    private readonly dir: string,
    private readonly parse: (raw: string) => T,
    /** assertSafeId 错误消息中的对象名（如 "caseId" / "runId"）。 */
    private readonly what = "id",
  ) {}

  private fileFor(id: string): string {
    // 防御路径注入：id 直接拼入文件路径，只允许安全字符集，
    // 禁止路径分隔符与 `..`（否则可写出 dir 目录，或写入隐藏文件）。
    assertSafeId(id, this.what);
    return `${this.dir}/${id}.json`;
  }

  async save(id: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(id);
    await atomicWriteJson(file, JSON.stringify(value, null, 2));
  }

  async load(id: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.fileFor(id), "utf8");
      return this.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listIds(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter(file => file.endsWith(".json"))
        .map(file => file.slice(0, -".json".length))
        .filter(id => SAFE_ID_PATTERN.test(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
