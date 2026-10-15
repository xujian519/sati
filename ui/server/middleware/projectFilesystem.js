/**
 * 项目文件路由的 root 守卫（上游 #648）。
 *
 * 两条不变式：
 * 1. 授权用的 root 只能来自项目注册表——**不得**来自请求参数或 `getProjects()` 填充的
 *    展示层缓存（见 `../services/projectRegistration.js`）。
 * 2. 与 app home（`~/.sati`，置放 `server-token` 与 `sati.yaml`）重叠的 root 一律拒绝，
 *    父子两个方向都拒；软链与大小写别名在 `realpath` 规范化之后再判一次（词法判定看不穿
 *    这两类别名，正是要在这里兜住）。
 *
 * 通过后把 root 挂到 `req.projectRoot`，下游处理器只许用它，不再自行解析。
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRegisteredProject } from "../services/projectRegistration.js";
import { resolvePilotHome } from "../utils/pilotPaths.js";
import { pathsOverlap } from "../utils/pathSafety.js";

/** 403：路径按设计不可用于文件操作（虚拟工作区 / 与 app home 重叠）。 */
function forbidden(res) {
  return res.status(403).json({
    error: {
      code: "PROJECT_PATH_FORBIDDEN",
      message: "Project file operations are unavailable for this path.",
    },
  });
}

/** 404：未注册、登记已失效，或工作区已不存在。 */
function notFound(res) {
  return res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found" } });
}

/**
 * 构造守卫中间件。
 *
 * @param {{ env?: Record<string, string | undefined> }} [options] `env` 供测试注入（读 `SATI_HOME`）。
 * @returns {(req: any, res: any, next: any) => Promise<unknown>} Express 中间件。
 */
export function createProjectFilesystemMiddleware({ env = process.env } = {}) {
  return async (req, res, next) => {
    try {
      const pilotHome = resolvePilotHome(env);
      const projectRoot = await resolveRegisteredProject(req.params.projectName, pilotHome);
      // 词法判定看不穿软链与大小写别名，故规范化之后再判一次。
      const [realProjectRoot, realPilotHome] = await Promise.all([realpath(projectRoot), realpath(pilotHome)]);
      if (pathsOverlap(projectRoot, pilotHome) || pathsOverlap(realProjectRoot, realPilotHome)) {
        return forbidden(res);
      }
      if (!(await stat(projectRoot)).isDirectory()) {
        return notFound(res);
      }
      req.projectRoot = path.resolve(projectRoot);
      return next();
    } catch (error) {
      if (error.code === "PROJECT_NOT_FOUND" || error.code === "ENOENT" || error.code === "ENOTDIR") {
        return notFound(res);
      }
      return next(error);
    }
  };
}
