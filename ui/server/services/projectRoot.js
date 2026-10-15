/**
 * 项目 root 的授权解析（#648 的共用收口）。
 *
 * 两条不变式（与 `../middleware/projectFilesystem.js` 同源，故放在一处）：
 * 1. root 只来自项目注册表（`./projectRegistration.js`），**不得**来自请求参数或展示层缓存。
 * 2. 与 app home 重叠的 root 一律拒绝，父子两个方向都拒；软链与大小写别名在 `realpath`
 *    规范化之后再判一次（词法判定看不穿这两类别名）。
 *
 * 需要 root 的处理器共用本函数，而不是各自实现一遍——分散的判定迟早会有一处漏掉某条不变式。
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRegisteredProject } from "./projectRegistration.js";
import { resolvePilotHome } from "../utils/pilotPaths.js";
import { pathsOverlap } from "../utils/pathSafety.js";

/** 403：路径按设计不可用于文件操作（虚拟工作区 / 与 app home 重叠）。 */
export function projectPathForbidden() {
  return Object.assign(new Error("Project file operations are unavailable for this path."), {
    code: "PROJECT_PATH_FORBIDDEN",
    status: 403,
  });
}

/** 404：未注册、登记已失效，或工作区已不存在。 */
export function projectMissing() {
  return Object.assign(new Error("Project not found"), { code: "PROJECT_NOT_FOUND", status: 404 });
}

/**
 * 解析请求传来的项目名，返回**已授权**的工作区 root。
 *
 * @param {string} name 请求参数中的项目名（id、可反推的真实路径，或工作区自身的绝对路径）。
 * @param {{ env?: Record<string, string | undefined>, allowAppHomeOverlap?: boolean }} [options]
 *   `env` 供测试注入（读 `SATI_HOME`）。`allowAppHomeOverlap` 只给**不解析请求方所选路径**的面用
 *   （聊天附件面）：那里只往 root 下写服务端构造的目标，够不到 app home 里的 `server-token`。
 * @returns {Promise<string>} 绝对 root。
 * @throws {Error} 未注册 / 非法 / 登记失效 → `PROJECT_NOT_FOUND`；与 app home 重叠 → `PROJECT_PATH_FORBIDDEN`。
 */
export async function resolveAuthorizedProjectRoot(name, { env = process.env, allowAppHomeOverlap = false } = {}) {
  const pilotHome = resolvePilotHome(env);
  const projectRoot = await resolveRegisteredProject(name, pilotHome);
  if (!allowAppHomeOverlap) {
    // 词法判定看不穿软链与大小写别名，故规范化之后再判一次。
    const [realProjectRoot, realPilotHome] = await Promise.all([realpath(projectRoot), realpath(pilotHome)]);
    if (pathsOverlap(projectRoot, pilotHome) || pathsOverlap(realProjectRoot, realPilotHome)) {
      throw projectPathForbidden();
    }
  }
  const info = await stat(projectRoot).catch(() => null);
  if (!info?.isDirectory()) {
    throw projectMissing();
  }
  return path.resolve(projectRoot);
}
