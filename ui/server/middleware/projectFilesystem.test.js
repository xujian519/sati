// @vitest-environment node
/**
 * 项目文件 root 守卫（上游 #648）。
 *
 * 判据分两层：**授权来源**（root 只能来自项目注册表，不得由请求参数或展示层缓存推导）与
 * **重叠拒绝**（与 app home 父子两个方向都拒，含软链与大小写别名）。后两类别名词法判定看不穿，
 * 靠 `realpath` 规范化后的第二次判定兜住——摘掉那一对判定，软链与大小写两条用例即转红。
 */
import express from "express";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectFilesystemMiddleware } from "./projectFilesystem.js";

let root;
let home;
let workspace;
let env;
let server;
let baseUrl;

const nativeFetch = globalThis.fetch;

async function register(id, cwd) {
  const storage = path.join(home, "projects", id);
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(storage, ".cwd"), cwd);
  return storage;
}

function request(projectName) {
  return nativeFetch(`${baseUrl}/${encodeURIComponent(projectName)}/root`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sati-root-guard-"));
  home = path.join(root, "state");
  workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(home, "projects"), { recursive: true });
  // app home 真实存放 server-token / sati.yaml —— 重叠拒绝要保护的就是它们。
  await writeFile(path.join(home, "server-token"), "fake-server-token");
  await writeFile(path.join(workspace, "normal.txt"), "normal");
  await register("demo", workspace);

  env = { SATI_HOME: home };
  const app = express();
  app.use("/api/projects/:projectName/root", createProjectFilesystemMiddleware({ env }), (req, res) => {
    res.json({ root: req.projectRoot });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe("授权来源", () => {
  it("拒绝未注册的绝对路径、短横线解码形态与未知 id", async () => {
    for (const name of ["/root", "/etc", root, "-root", "-etc", "unknown"]) {
      const response = await request(name);
      expect(response.status, `${name} 应被拒`).toBe(404);
      expect((await response.json()).error.code).toBe("PROJECT_NOT_FOUND");
    }
  });

  it("接受已注册 id，并把解析出的 root 注入 req.projectRoot", async () => {
    const response = await request("demo");
    expect(response.status).toBe(200);
    expect((await response.json()).root).toBe(workspace);
  });

  it("接受工作区自身的绝对路径（须与某条登记精确等值）", async () => {
    const response = await request(workspace);
    expect(response.status).toBe(200);
    expect((await response.json()).root).toBe(workspace);
  });

  it("接受指向普通工作区的软链别名（登记即授权）", async () => {
    const alias = path.join(root, "workspace-alias");
    await symlink(workspace, alias, "dir");
    await register("demo", alias);
    const response = await request("demo");
    expect(response.status).toBe(200);
    expect((await response.json()).root).toBe(alias);
  });

  it("登记被删除或工作区已消失时回 404（每次访问重新落盘读取）", async () => {
    expect((await request("demo")).status).toBe(200);

    await rm(path.join(home, "projects", "demo"), { recursive: true });
    expect((await request("demo")).status).toBe(404);

    // 登记目录在、但指向的 root 已不存在
    await register("demo", path.join(root, "gone"));
    expect((await request("demo")).status).toBe(404);
  });

  it("登记目录是软链、或 .cwd 是软链时不认", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(home, "projects", "linked"), "dir");
    expect((await request("linked")).status).toBe(404);

    const markerTarget = path.join(root, "marker-target");
    await writeFile(markerTarget, workspace);
    const storage = await register("markerlink", workspace);
    await rm(path.join(storage, ".cwd"));
    await symlink(markerTarget, path.join(storage, ".cwd"), "file");
    expect((await request("markerlink")).status).toBe(404);
  });

  it(".cwd 写成相对路径或空值时该登记失效", async () => {
    for (const marker of ["", "relative/path"]) {
      await register("badmarker", marker);
      expect((await request("badmarker")).status).toBe(404);
    }
  });
});

describe("与 app home 重叠一律拒绝", () => {
  it("general 虚拟工作区（root 即 app home）回 403 而非 404", async () => {
    const response = await request("general");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("PROJECT_PATH_FORBIDDEN");
  });

  it("app home 自身、其父目录、其子目录两条方向都拒", async () => {
    for (const [id, cwd] of [
      ["home", home],
      ["parent", root],
      ["child", path.join(home, "projects")],
      ["secretdir", path.join(home, "projects", "demo")],
    ]) {
      await register(id, cwd);
      const response = await request(id);
      expect(response.status, `${id} → ${cwd} 应被拒`).toBe(403);
      expect((await response.json()).error.code).toBe("PROJECT_PATH_FORBIDDEN");
    }
  });

  it("以 app home 的绝对路径直接请求也拒", async () => {
    expect((await request(home)).status).toBe(403);
  });

  it("app home 是软链时，别名与真实路径两条都拒", async () => {
    const homeAlias = path.join(root, "home-alias");
    await symlink(home, homeAlias, "dir");
    env.SATI_HOME = homeAlias;

    for (const [id, cwd] of [
      ["aliased-home", homeAlias],
      ["aliased-child", path.join(homeAlias, "projects")],
      ["real-home", home],
      ["real-child", path.join(home, "projects")],
    ]) {
      await register(id, cwd);
      expect((await request(id)).status, `${id} 应被拒`).toBe(403);
    }
  });

  it.skipIf(process.platform !== "darwin")("大小写别名不得绕过重叠判定（macOS 大小写不敏感卷）", async () => {
    await register("cased", home.toUpperCase());
    const response = await request("cased");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("PROJECT_PATH_FORBIDDEN");
  });

  it("普通工作区不受重叠判定影响", async () => {
    const response = await request("demo");
    expect(response.status).toBe(200);
    expect((await response.json()).root).toBe(workspace);
  });
});

describe("放行 app home 重叠（只给不解析请求方路径的面）", () => {
  async function startOverlapApp() {
    const app = express();
    app.use(
      "/api/projects/:projectName/root",
      createProjectFilesystemMiddleware({ env, allowAppHomeOverlap: true }),
      (req, res) => {
        res.json({ root: req.projectRoot });
      },
    );
    const overlapServer = app.listen(0, "127.0.0.1");
    await new Promise(resolve => overlapServer.once("listening", resolve));
    return {
      url: `http://127.0.0.1:${overlapServer.address().port}/api/projects`,
      close: async () => {
        overlapServer.closeAllConnections();
        await new Promise(resolve => overlapServer.close(resolve));
      },
    };
  }

  it("general 与落在 app home 内的登记都能解析出 root", async () => {
    const app = await startOverlapApp();
    try {
      await register("child", path.join(home, "projects"));
      const general = await nativeFetch(`${app.url}/general/root`);
      expect(general.status).toBe(200);
      expect((await general.json()).root).toBe(home);
      expect((await nativeFetch(`${app.url}/child/root`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("未注册、非法与登记失效的 root 仍被拒（放行的只有重叠判定）", async () => {
    const app = await startOverlapApp();
    try {
      for (const name of ["unknown", "/etc", "-etc", root]) {
        const response = await nativeFetch(`${app.url}/${encodeURIComponent(name)}/root`);
        expect(response.status, `${name} 应被拒`).toBe(404);
        expect((await response.json()).error.code).toBe("PROJECT_NOT_FOUND");
      }
    } finally {
      await app.close();
    }
  });
});
