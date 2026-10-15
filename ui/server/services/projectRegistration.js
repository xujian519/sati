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
import { homedir } from "node:os";
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
  // 登记目录必须是真实目录：`lstat` 不跟随软链，软链的 `isDirectory()` 恒为 false，
  // 因此「软链可以把 `.cwd` 引到注册表之外」由类型判定本身挡住。
  if (!info?.isDirectory()) {
    return null;
  }
  try {
    const marker = path.join(storage, ".cwd");
    const markerInfo = await fs.lstat(marker);
    if (!markerInfo.isFile()) {
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
 * 目标目录是否存在且可读。
 *
 * @param {string} target 待判目录。
 * @returns {Promise<boolean>} 存在且可读。
 */
async function isReadableDir(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    // access 抛错（通常是 ENOENT）→ 视为该层不存在，由调用方决定是否回退。
    return false;
  }
}

/**
 * 项目注册表所在目录。
 *
 * `<app home>/projects` 不可读时回退到 rebrand 前的 `~/.pilotdeck/projects`——与
 * `src/web/server/listProjects.ts`（侧边栏的项目清单）**同一条** legacy 兼容规则。两边不一致
 * 时，升级用户的症状是「项目列得出来、每个文件面都 404」，比整体不支持更难诊断。
 *
 * @param {string} pilotHome 当前 app home。
 * @returns {Promise<string>} 实际可读的注册表目录（都不可读时返回 `<app home>/projects`）。
 */
async function resolveProjectsDir(pilotHome) {
  const projectsDir = path.join(pilotHome, "projects");
  if (await isReadableDir(projectsDir)) {
    return projectsDir;
  }
  const legacyProjectsDir = path.join(homedir(), ".pilotdeck", "projects");
  if (await isReadableDir(legacyProjectsDir)) {
    return legacyProjectsDir;
  }
  return projectsDir;
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
  const projectsDir = await resolveProjectsDir(pilotHome);
  if (!path.isAbsolute(name)) {
    const root = await readRegisteredProject(projectsDir, name);
    if (root) {
      return root;
    }
  } else {
    const root = await findRegisteredProjectByPath(projectsDir, name);
    if (root) {
      return root;
    }
  }
  throw projectNotFound();
}

/**
 * 按绝对路径查已登记的项目。
 *
 * 先按 legacy 编码直接定位候选目录（O(1)，也是常见情形）；未命中再全表扫描——碰撞抗性 id
 * （`<legacyId>--<digest>`）只能这样找。扫描里除词法等值外再比一次 `realpath`：UI 手上的路径
 * 可能已被规范化（macOS `/var` ↔ `/private/var` 这类别名），词法不等但指向同一目录时不该
 * 判成「未注册」。返回值始终是**登记里的** root，不返回请求方给的路径。
 *
 * @param {string} projectsDir 注册表目录。
 * @param {string} requestedPath 请求方给的绝对路径。
 * @returns {Promise<string | null>} 已登记的 root，或 `null`。
 */
async function findRegisteredProjectByPath(projectsDir, requestedPath) {
  const requested = path.resolve(requestedPath);
  const direct = await readRegisteredProject(projectsDir, createProjectId(requested));
  if (direct && path.resolve(direct) === requested) {
    return direct;
  }
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const requestedReal = await fs.realpath(requested).catch(() => null);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const root = await readRegisteredProject(projectsDir, entry.name);
    if (!root) {
      continue;
    }
    if (path.resolve(root) === requested) {
      return root;
    }
    if (requestedReal && (await fs.realpath(root).catch(() => null)) === requestedReal) {
      return root;
    }
  }
  return null;
}
