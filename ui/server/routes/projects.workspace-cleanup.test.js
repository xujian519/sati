// @vitest-environment node
/**
 * 工作区创建的失败路径不得删除已存在的目录。
 *
 * `workspaceType: "new"` 并不要求目标路径事先不存在（`validateWorkspacePath` 只拒系统关键
 * 目录），因此「已存在的路径 + 查不到的 githubTokenId + 有 githubUrl」是合法请求。若在解析
 * clone 凭据**之前**就 `mkdir`，凭据查不到时的 `fs.rm(path, { recursive: true })` 会连带删掉
 * 整棵已存在的目录树——这是数据毁灭路径，不是权限边界问题。
 *
 * 回归判据：凭据解析必须先于任何文件系统改动；查不到就直接报错，且**不清理**（此时什么都还没建）。
 */
import express from "express";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "sati-workspace-cleanup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createProjectsApp() {
  const addProjectManually = vi.fn(async () => ({ id: "p1", path: "/tmp" }));

  vi.doMock("../utils/consoleLogger.js", () => ({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock("../projects.js", () => ({ addProjectManually }));
  vi.doMock("../discovery-plans.js", () => ({
    getProjectDiscoveryPlansOverview: vi.fn(),
    getProjectDiscoveryPlanReport: vi.fn(),
    rerunDiscoveryPlan: vi.fn(),
    getProjectWorkCycles: vi.fn(),
    applyWorkCycle: vi.fn(),
    archiveWorkCycle: vi.fn(),
  }));
  vi.doMock("../knowledge.js", () => ({ getKnowledgeCapabilities: vi.fn() }));
  // 凭据查不到：getGithubTokenById 落到 db.prepare(...).get()
  vi.doMock("../database/db.js", () => ({
    db: { prepare: () => ({ get: () => undefined }) },
  }));

  const { default: projectsRoutes } = await import("./projects.js");
  const app = express();
  app.use(express.json());
  // 真实挂载形态是 `app.use("/api/projects", authenticateToken, projectsRoutes)`
  // （ui/server/index.js）；这里用等价的最小替身注入 req.user。
  app.use(
    "/api/projects",
    (req, _res, next) => {
      req.user = { id: 1 };
      next();
    },
    projectsRoutes,
  );

  return {
    addProjectManually,
    request: (path, init) => requestJson(app, path, init),
    requestText: (path, init) => requestText(app, path, init),
  };
}

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    return await run(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function requestJson(app, path, init = {}) {
  return withServer(app, async port => {
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  });
}

async function requestText(app, path, init = {}) {
  return withServer(app, async port => {
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, text: await response.text() };
  });
}

function makeExistingWorkspace() {
  const parent = makeTempDir();
  const target = join(parent, "dev");
  mkdirSync(join(target, "nested"), { recursive: true });
  writeFileSync(join(target, "keep.txt"), "precious");
  writeFileSync(join(target, "nested", "deep.txt"), "deep");
  return { parent, target };
}

const CLONE_URL = "https://github.com/example/repo.git";
const MISSING_TOKEN_ID = 424242;

describe("POST /create-workspace 失败路径", () => {
  it("凭据查不到时保留已存在的目标目录", async () => {
    const { target } = makeExistingWorkspace();
    const { addProjectManually, request } = await createProjectsApp();

    const result = await request("/api/projects/create-workspace", {
      method: "POST",
      body: JSON.stringify({
        path: target,
        workspaceType: "new",
        githubUrl: CLONE_URL,
        githubTokenId: MISSING_TOKEN_ID,
      }),
    });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "GitHub token not found" });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("precious");
    expect(readFileSync(join(target, "nested", "deep.txt"), "utf8")).toBe("deep");
    // 失败路径不得登记项目
    expect(addProjectManually).not.toHaveBeenCalled();
  });

  it("凭据查不到时不创建目标目录", async () => {
    const parent = makeTempDir();
    const target = join(parent, "brand-new");
    const { request } = await createProjectsApp();

    const result = await request("/api/projects/create-workspace", {
      method: "POST",
      body: JSON.stringify({
        path: target,
        workspaceType: "new",
        githubUrl: CLONE_URL,
        githubTokenId: MISSING_TOKEN_ID,
      }),
    });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "GitHub token not found" });
    expect(existsSync(target)).toBe(false);
    // 父目录本身不被顺手创建
    expect(existsSync(parent)).toBe(true);
  });

  it("无 githubUrl 时不解析凭据，目录照常创建", async () => {
    const parent = makeTempDir();
    const target = join(parent, "plain");
    const { addProjectManually, request } = await createProjectsApp();

    const result = await request("/api/projects/create-workspace", {
      method: "POST",
      body: JSON.stringify({
        path: target,
        workspaceType: "new",
        githubTokenId: MISSING_TOKEN_ID,
      }),
    });

    expect(result.status).toBe(200);
    expect(existsSync(target)).toBe(true);
    // 登记的路径是 realpath 规范化后的（macOS 的 /var → /private/var）
    expect(addProjectManually).toHaveBeenCalledWith(realpathSync(target));
  });
});

describe("GET /clone-progress 失败路径", () => {
  it("凭据查不到时保留已存在的目标目录", async () => {
    const { target } = makeExistingWorkspace();
    const { requestText } = await createProjectsApp();

    const query = new URLSearchParams({
      path: target,
      githubUrl: CLONE_URL,
      githubTokenId: String(MISSING_TOKEN_ID),
    });
    const result = await requestText(`/api/projects/clone-progress?${query}`);

    expect(result.status).toBe(200);
    expect(result.text).toContain("GitHub token not found");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("precious");
    expect(readFileSync(join(target, "nested", "deep.txt"), "utf8")).toBe("deep");
  });
});
