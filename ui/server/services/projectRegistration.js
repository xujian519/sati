/**
 * 项目注册表解析（上游 #648）。
 *
 * 文件 API 的 root 此前由**请求参数**推导——绝对路径原样透传、`-Users-foo` 短横线解码、
 * 以及 `getProjects()` 填充的展示层缓存；随后的「包含性检查」是在请求方选定的边界上做的，
 * 不构成边界。这里改为只认注册表：`<app home>/projects/<id>/.cwd` 标记，或能被 legacy 编码
 * 反推且真实存在的目录。
 *
 * 判定每次重新落盘读取（不做缓存）：注册会在运行中被删除 / 改指，缓存会把已失效的登记
 * 继续当授权用。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createProjectId } from "../utils/pilotPaths.js";

/** 项目不可解析（未注册 / 路径非法 / 登记已失效）时的统一错误。 */
export function projectNotFound() {
  return Object.assign(new Error("Project not found"), { code: "PROJECT_NOT_FOUND", status: 404 });
}

/**
 * 按项目 id 读注册表，返回其工作区 root；未注册或登记已失效时返回 `null`。
 *
 * @param {string} projectsDir `<app home>/projects` 目录。
 * @param {string} id 项目 id（`state` 目录名）。
 * @returns {Promise<string | null>} 绝对 root，或 `null`。
 */
export async function readRegisteredProject(projectsDir, id) {
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    return null;
  }
  const storage = path.join(projectsDir, id);
  const info = await fs.lstat(storage).catch(() => null);
  // 登记目录必须是真实目录：软链可以把 `.cwd` 引到注册表之外。
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    return null;
  }
  try {
    const marker = path.join(storage, ".cwd");
    const markerInfo = await fs.lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      return null;
    }
    const root = (await fs.readFile(marker, "utf8")).trim();
    if (!root || !path.isAbsolute(root) || root.includes("\0")) {
      return null;
    }
    // 会话可以比工作区活得久——root 是否真的还在，由文件路由在访问时判。
    return path.resolve(root);
  } catch (error) {
    if (error.code !== "ENOENT") {
      return null;
    }
    return readLegacyEncodedProject(id);
  }
}

/**
 * 无 `.cwd` 标记时的回退：只有 id 能由**真实存在**的目录按 legacy 编码（`-` 即路径分隔符）
 * 反推出来时才认，故返回的路径必定存在。
 *
 * @param {string} id 项目 id（`state` 目录名）。
 * @returns {Promise<string | null>} 反推出的绝对 root，或 `null`。
 */
async function readLegacyEncodedProject(id) {
  const parts = id.split("-");
  for (let start = 0; start < parts.length; start++) {
    const candidates = [`/${parts.slice(start).join("/")}`];
    if (process.platform === "win32") {
      for (const drive of ["C", "D", "E"]) {
        candidates.push(`${drive}:\\${parts.slice(start).join("\\")}`);
      }
    }
    for (const candidate of candidates) {
      if (createProjectId(candidate) === id && (await fs.stat(candidate).catch(() => null))?.isDirectory()) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 解析请求传来的 `projectName`，只返回**已注册**的工作区 root。
 *
 * 接受的形态：项目 id、可反推的真实目录路径、以及工作区自身的绝对路径（须与某条登记
 * 精确等值）。`general`（虚拟工作区，root 即 app home）解析为 app home 本身，由守卫据此
 * 回 403 而非 404——调用方据此区分「设计如此不可用」与「项目不存在」。
 *
 * @param {string} name 请求参数中的项目名。
 * @param {string} pilotHome 当前 app home（`SATI_HOME` 或 `~/.sati`）。
 * @returns {Promise<string>} 绝对 root。
 * @throws {Error} 未注册 / 非法 / 登记失效时抛 `PROJECT_NOT_FOUND`。
 */
export async function resolveRegisteredProject(name, pilotHome) {
  if (typeof name !== "string" || !name || name.includes("\0")) {
    throw projectNotFound();
  }
  if (name === "general" || (path.isAbsolute(name) && path.resolve(name) === path.resolve(pilotHome))) {
    return path.resolve(pilotHome);
  }
  const projectsDir = path.join(pilotHome, "projects");
  if (!path.isAbsolute(name)) {
    const root = await readRegisteredProject(projectsDir, name);
    if (root) {
      return root;
    }
  } else {
    const requested = path.resolve(name);
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const root = await readRegisteredProject(projectsDir, entry.name);
      if (root && path.resolve(root) === requested) {
        return root;
      }
    }
  }
  throw projectNotFound();
}
