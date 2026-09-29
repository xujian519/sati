/**
 * 配置文件 I/O 原语：路径解析（跟随软链）、稳定读、原子写。
 *
 * 与 satiConfig.js 的"配置 schema / 校验 / 序列化"职责分开：这一层只管
 * "把一段文本安全地落到磁盘上的正确位置"，因此可以单独测试软链、崩溃原子性
 * 与稳定读，不必先构造一份合法配置。
 */

import fsPromises from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

/** 稳定读的间隔与次数：读到"两次一致"才认账，避开外部编辑器正在写的那一瞬。 */
export const CONFIG_SETTLE_MS = 250;
export const CONFIG_SETTLE_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 稳定读：连续两次读到相同内容才返回，否则退避重试；始终不稳定时调用
 * `makeUnstableError`（fail-closed，不拿一个可疑基准去写）。
 *
 * 外部编辑器（vim / Cursor）落盘期间读到半截 YAML 会让 revision 比对失真，
 * 重试成本只是几百毫秒。
 *
 * @param readConfigFile 读取函数，返回含 `exists` 与 `raw` 的记录。
 */
export async function readStableConfigRecord(
  readConfigFile,
  { makeUnstableError, settleMs = CONFIG_SETTLE_MS, maxAttempts = CONFIG_SETTLE_ATTEMPTS },
) {
  let previous = readConfigFile();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(settleMs);
    const current = readConfigFile();
    if (current.exists === previous.exists && current.raw === previous.raw) {
      return current;
    }
    previous = current;
  }
  throw makeUnstableError(previous);
}

/**
 * 解析出真正要写的路径：配置文件是软链时写它的目标，而不是用 rename 把软链
 * 换成一个普通文件（那会让 `~/.sati/sati.yaml` 这类软链失去意义）。
 * 逐级跟随软链；路径不存在时退回解析父目录，否则创建不出文件。
 */
export async function resolveConfigWritePath(configPath) {
  let current = path.resolve(configPath);
  const visited = new Set();
  for (;;) {
    if (visited.has(current)) {
      const error = new Error(`Too many symbolic links while resolving config path: ${configPath}`);
      error.code = "ELOOP";
      throw error;
    }
    visited.add(current);

    let stat;
    try {
      stat = await fsPromises.lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const resolvedDir = await fsPromises.realpath(path.dirname(current)).catch(dirError => {
        if (dirError?.code === "ENOENT") return path.dirname(current);
        throw dirError;
      });
      return path.join(resolvedDir, path.basename(current));
    }
    if (!stat.isSymbolicLink()) return fsPromises.realpath(current);

    const linkTarget = await fsPromises.readlink(current);
    current = path.resolve(path.dirname(current), linkTarget);
  }
}

/**
 * 原子写：同目录 temp + fsync + rename，随后 best-effort fsync 目录。
 *
 * - temp 名以 `.` 开头且不等于配置文件名，satiConfigWatcher 的目录事件按文件名
 *   精确过滤，不会因为 temp 而误触发 reload；
 * - 先 fsync 数据再 rename，否则崩溃后可能留下"名字换了、内容没落"的空文件；
 * - 失败时清理 temp，磁盘保持旧内容；
 * - `onWriteCommitted` 在 rename 之后才调用：失败的保存不该顺手吞掉外部变更事件。
 */
export async function writeConfigAtomically({ writePath, raw, onWriteCommitted }) {
  const configDir = path.dirname(writePath);
  await fsPromises.mkdir(configDir, { recursive: true });

  // 保留既有权限；新文件用 0600（配置里有凭证，不该按 umask 落到更宽）。
  let mode = 0o600;
  try {
    mode = (await fsPromises.stat(writePath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const tmpPath = path.join(configDir, `.${path.basename(writePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await fsPromises.open(tmpPath, "wx", mode);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(tmpPath, writePath);
    if (typeof onWriteCommitted === "function") {
      onWriteCommitted();
    }
    try {
      const dirHandle = await fsPromises.open(configDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // 目录 fsync 并非所有平台/文件系统都支持。
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fsPromises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
