/**
 * 项目文件路由的 root 守卫（上游 #648）。
 *
 * 两条不变式（判定链在 `../services/projectRoot.js`，与 git 路由共用同一实现）：
 * 1. 授权用的 root 只能来自项目注册表——**不得**来自请求参数或 `getProjects()` 填充的
 *    展示层缓存。
 * 2. 与 app home（`~/.sati`，置放 `server-token` 与 `sati.yaml`）重叠的 root 一律拒绝。
 *
 * 通过后把 root 挂到 `req.projectRoot`，下游处理器只许用它，不再自行解析。
 */
import { resolveAuthorizedProjectRoot } from "../services/projectRoot.js";

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
 * @param {{ env?: Record<string, string | undefined>, allowAppHomeOverlap?: boolean }} [options]
 *   `env` 供测试注入（读 `SATI_HOME`）。`allowAppHomeOverlap` 只给**不解析请求方所选路径**的面用
 *   （见 `../routes/project-uploads.js` 的聊天附件面）：重叠判定的目的是让 app home 内的
 *   `server-token` / `sati.yaml` 在文件 API 上不可读不可改，而这类面只往注册表 root 下的
 *   服务端构造目标写，够不到那两个文件；不放行则 General（root 即 app home）的附件上传整条 403。
 * @returns {(req: any, res: any, next: any) => Promise<unknown>} Express 中间件。
 */
export function createProjectFilesystemMiddleware({ env = process.env, allowAppHomeOverlap = false } = {}) {
  return async (req, res, next) => {
    try {
      req.projectRoot = await resolveAuthorizedProjectRoot(req.params.projectName, { env, allowAppHomeOverlap });
      return next();
    } catch (error) {
      if (error.code === "PROJECT_PATH_FORBIDDEN") {
        return forbidden(res);
      }
      if (error.code === "PROJECT_NOT_FOUND" || error.code === "ENOENT" || error.code === "ENOTDIR") {
        return notFound(res);
      }
      return next(error);
    }
  };
}
