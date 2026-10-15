// @vitest-environment node
/**
 * TaskMaster 项目面的 root 授权与文件名收口。
 *
 * 这个路由族同时具备三件事：按 root 写文件（`apply-template`）、按 root 起 CLI（`init` /
 * `add-task` / `update-task` / `parse-prd`）、以及从 `req.body` 取文件名直接拼路径。判据分两层：
 *
 * 1. **接线契约**（源码扫描）：每个 `:projectName` 面都挂在 root 守卫之后；文件里不再有
 *    `shell: true`（`prompt` / `fileName` 之类请求体字段不再经过 shell 解析）。
 * 2. **端到端**（真实 router + 真实守卫 + 真实 fs）：未注册 / 与 app home 重叠的 root 一律
 *    不落地、不起 CLI；`fileName` 含分隔符或 `..` 时回 400 且写不出 `.taskmaster/docs` 之外。
 */
import express from "express";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectId } from "../utils/pilotPaths.js";

const nativeFetch = globalThis.fetch;

let root;
let home;
let workspace;
let server;
let baseUrl;

/** 在临时 app home 里登记一个工作区（与 gateway 写的 `<home>/projects/<id>/.cwd` 同形）。 */
async function register(cwd, id = createProjectId(cwd)) {
  const storage = path.join(home, "projects", id);
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(storage, ".cwd"), cwd);
  return storage;
}

async function createApp() {
  vi.doMock("../utils/consoleLogger.js", () => ({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock("../utils/taskmaster-websocket.js", () => ({
    broadcastTaskMasterProjectUpdate: vi.fn(),
    broadcastTaskMasterTasksUpdate: vi.fn(),
  }));
  const { default: taskmasterRoutes } = await import("./taskmaster.js");
  const instance = express();
  instance.use(express.json());
  instance.use("/api/taskmaster", taskmasterRoutes);
  return instance;
}

function request(suffix, { method = "GET", body } = {}) {
  return nativeFetch(`${baseUrl}${suffix}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "sati-taskmaster-guard-")));
  home = path.join(root, "state");
  workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(home, "projects"), { recursive: true });
  await writeFile(path.join(home, "server-token"), "fake-server-token");

  process.env.SATI_HOME = home;
  const app = await createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/taskmaster`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  delete process.env.SATI_HOME;
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe("root 只认注册表", () => {
  it.each([
    ["未注册 id", "unknown"],
    ["未注册的绝对路径", () => path.join(tmpdir(), "definitely-not-registered")],
    ["短横线解码形态", "-tmp-definitely-not-registered"],
  ])("%s 的任务面回 404", async (caseName, name) => {
    const target = typeof name === "function" ? name() : name;
    const faces = [
      ["GET", `/tasks/${encodeURIComponent(target)}`],
      ["POST", `/init/${encodeURIComponent(target)}`],
      ["POST", `/add-task/${encodeURIComponent(target)}`],
      ["POST", `/parse-prd/${encodeURIComponent(target)}`],
      ["POST", `/apply-template/${encodeURIComponent(target)}`],
    ];
    for (const [method, suffix] of faces) {
      const response = await request(suffix, { method, body: method === "POST" ? {} : undefined });
      expect(response.status, `${caseName} → ${suffix}`).toBe(404);
    }
  });

  it("general 与 app home 的任务面回 403", async () => {
    for (const name of ["general", home]) {
      for (const suffix of [`/tasks/${encodeURIComponent(name)}`, `/apply-template/${encodeURIComponent(name)}`]) {
        const response = await request(suffix, { method: suffix.startsWith("/apply") ? "POST" : "GET" });
        expect(response.status, `${name} → ${suffix}`).toBe(403);
      }
    }
  });

  it("已注册工作区的任务列表照常可读", async () => {
    await register(workspace, "demo");
    await mkdir(path.join(workspace, ".taskmaster", "tasks"), { recursive: true });
    await writeFile(
      path.join(workspace, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({ tasks: [{ id: 1, title: "probe" }] }),
    );

    const response = await request("/tasks/demo");
    expect(response.status).toBe(200);
    expect((await response.json()).tasks[0]).toMatchObject({ id: 1, title: "probe" });
  });
});

describe("fileName 收口", () => {
  it.each([
    ["父目录穿越", "../../../escaped.txt"],
    ["绝对路径", "/tmp/escaped.txt"],
    ["反斜杠", "..\\escaped.txt"],
    ["空值", "   "],
  ])("%s 的 apply-template 回 400 且不落盘", async (caseName, fileName) => {
    await register(workspace, "demo");

    const response = await request("/apply-template/demo", {
      method: "POST",
      body: { templateId: "web-app", fileName },
    });

    expect(response.status, `${caseName} 应被拒`).toBe(400);
    expect(await readFile(path.join(home, "server-token"), "utf8")).toBe("fake-server-token");
    await expect(stat(path.join(root, "escaped.txt"))).rejects.toThrow();
    await expect(stat(path.join(workspace, "escaped.txt"))).rejects.toThrow();
  });

  it("合法的文件名写在 .taskmaster/docs 之内", async () => {
    await register(workspace, "demo");

    const response = await request("/apply-template/demo", {
      method: "POST",
      body: { templateId: "web-app", fileName: "prd-draft.md" },
    });

    expect(response.status).toBe(200);
    const written = await readFile(path.join(workspace, ".taskmaster", "docs", "prd-draft.md"), "utf8");
    expect(written).toContain("Product Requirements Document");
  });

  it("parse-prd 的穿越文件名在起 CLI 之前就被拦下", async () => {
    await register(workspace, "demo");
    const response = await request("/parse-prd/demo", {
      method: "POST",
      body: { fileName: "../../../escaped.txt" },
    });
    expect(response.status).toBe(400);
    await expect(stat(path.join(root, "escaped.txt"))).rejects.toThrow();
  });
});

describe("接线契约", () => {
  const source = () => readFileSync(new URL("./taskmaster.js", import.meta.url), "utf8");

  /** `:projectName` 面（以及 `:projectName/:taskId` 形态）必须挂守卫。 */
  function projectFaces() {
    const text = source();
    const matches = [...text.matchAll(/router\.(?:get|post|put|delete|patch)\(\s*"(\/[^"]*:projectName[^"]*)"/g)];
    return matches.map((match, index) => ({
      path: match[1],
      chain: text.slice(match.index, matches[index + 1]?.index ?? text.length),
    }));
  }

  it("项目面条数与接线一致（条数为 0 时下面的断言会红）", () => {
    expect(projectFaces().map(face => face.path)).toEqual([
      "/tasks/:projectName",
      "/init/:projectName",
      "/add-task/:projectName",
      "/update-task/:projectName/:taskId",
      "/parse-prd/:projectName",
      "/apply-template/:projectName",
    ]);
  });

  it("每个项目面都挂在 root 守卫之后", () => {
    const unguarded = projectFaces()
      .filter(({ chain }) => !chain.includes("requireRegisteredProjectRoot"))
      .map(({ path: routePath }) => routePath);
    expect(unguarded).toEqual([]);
  });

  it("不再按 projectName 解析 root，也不再经 shell 起 CLI", () => {
    expect(source()).not.toContain("extractProjectDirectory");
    expect(source()).not.toContain("shell: true");
  });
});

describe("CLI 探活不经 shell", () => {
  it("installation-status 仍能取到安装状态", async () => {
    const response = await request("/installation-status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(typeof body.installation?.isInstalled).toBe("boolean");
  });
});
