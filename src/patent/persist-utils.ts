/**
 * 持久化共享工具（workflow-store / flexible-plan-store 共用）。
 *
 * - assertSafeId：文件路径安全字符校验（防 `..` / 路径分隔符 / 隐藏文件写入）
 * - atomicWriteJson：原子写（先写同目录临时文件再 rename，避免中断/并发产生半写 JSON）
 */

import { rename, writeFile } from "node:fs/promises";

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
