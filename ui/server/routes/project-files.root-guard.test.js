// @vitest-environment node
/**
 * 项目文件路由的 root 授权（上游 #648）。
 *
 * 两层判据：
 * 1. **接线契约**：三个路由文件里所有 `/api/projects/:projectName/…` 面都必须挂同一守卫，
 *    且处理器不再自行按 projectName 解析 root（此前 `extractProjectDirectory` + 短横线解码
 *    兜底等于让请求方自选 root）。用源码扫描钉住条数——路由表解析为空时该断言会因条数为 0
 *    而失败，不会静默变真。
 * 2. **端到端**：真实 router + 真实守卫，未注册 root 一律 404、app home 重叠一律 403，
 *    同时确认合法工作区的读/写/树/打包/上传照常可用（这是否认式改动的回归面）。
 */
import express from "express";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectId } from "../utils/pilotPaths.js";

const nativeFetch = globalThis.fetch;
const nativeFormData = globalThis.FormData;
const nativeBlob = globalThis.Blob;

let root;
let home;
let workspace;
let app;
let server;
let baseUrl;
const extractProjectDirectory = vi.fn();

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
  vi.doMock("../middleware/auth.js", () => ({
    authenticateToken: (req, res, next) => {
      if (req.headers.authorization === "Bearer test") {
        req.user = { id: 1 };
        return next();
      }
      return res.status(401).json({ error: "Access denied. No token provided." });
    },
    authenticateProjectPreview: (_req, _res, next) => next(),
    generateProjectPreviewToken: () => "preview-token",
    PROJECT_PREVIEW_TOKEN_TTL_SECONDS: 300,
  }));
  // 守卫在授权路径上会用到路由间共享的 WORKSPACES_ROOT / validateWorkspacePath
  vi.doMock("./projects.js", () => ({
    WORKSPACES_ROOT: tmpdir(),
    validateWorkspacePath: vi.fn(async input => ({ valid: true, resolvedPath: path.resolve(input) })),
  }));
  // 授权一旦回到「按 projectName 解析」就要被看见，故这里不提供可用实现
  vi.doMock("../projects.js", () => ({ extractProjectDirectory }));
  vi.doMock("../services/memoryService.js", () => ({
    resolveManagedMemoryFile: () => null,
    resolveProjectPath: vi.fn(),
    getMemoryServiceForRequest: vi.fn(),
  }));

  const { default: projectFilesRoutes } = await import("./project-files.js");
  const { default: projectUploadsRoutes } = await import("./project-uploads.js");
  const instance = express();
  instance.use(express.json());
  instance.use(projectFilesRoutes);
  instance.use(projectUploadsRoutes);
  return instance;
}

function request(projectName, suffix, { method = "GET", body, raw } = {}) {
  const headers = raw
    ? { Authorization: "Bearer test" }
    : { Authorization: "Bearer test", "Content-Type": "application/json" };
  return nativeFetch(`${baseUrl}/${encodeURIComponent(projectName)}${suffix}`, {
    method,
    headers,
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
}

function formData(name, content) {
  const form = new nativeFormData();
  form.append("files", new nativeBlob([content]), name);
  return form;
}

/** 聊天附件面读的是 `attachments` 字段（与文件上传面的 `files` 不同）。 */
function attachmentForm(name, content) {
  const form = new nativeFormData();
  form.append("attachments", new nativeBlob([content]), name);
  return form;
}

/**
 * 每个项目面各来一发：取值、字节、写盘、文件树、打包、上传。init 用工厂是因为上传必须
 * 每次新建 FormData（重复使用同一个实例会失败），且上传要走 POST——用 GET 打它只会拿到
 * Express 的「无此路由」404，看着像通过、实则没测到守卫。
 */
const PROJECT_SURFACES = [
  ["取值", "/file?filePath=normal.txt", () => ({})],
  ["字节", "/files/content?path=normal.txt", () => ({})],
  ["写盘", "/file", () => ({ method: "PUT", body: { filePath: "normal.txt", content: "edited" } })],
  ["文件树", "/files", () => ({})],
  ["打包", "/download", () => ({})],
  ["上传", "/files/upload", () => ({ method: "POST", raw: formData("probe.txt", "probe") })],
];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "sati-project-files-guard-")));
  home = path.join(root, "state");
  workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(home, "projects"), { recursive: true });
  // app home 真实存放 server-token / sati.yaml
  await writeFile(path.join(home, "server-token"), "fake-server-token");
  await writeFile(path.join(workspace, "normal.txt"), "normal");

  process.env.SATI_HOME = home;
  extractProjectDirectory.mockReset();
  app = await createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  delete process.env.SATI_HOME;
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe("端到端：授权来源", () => {
  it("未认证请求先被鉴权挡下", async () => {
    const response = await nativeFetch(`${baseUrl}/demo/file?filePath=normal.txt`);
    expect(response.status).toBe(401);
  });

  it.each([
    ["未注册 id", "unknown"],
    ["系统目录绝对路径", "/etc"],
    ["未注册的绝对路径", undefined],
    ["短横线解码形态", "-etc"],
  ])("%s 在全部项目面上回 404 且不泄露文件内容", async (caseName, name) => {
    const target = name ?? root;
    for (const [surface, suffix, init] of PROJECT_SURFACES) {
      const response = await request(target, suffix, init());
      expect(response.status, `${caseName} → ${surface} 应被拒`).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("normal");
      expect(body).not.toContain("fake-server-token");
    }
  });

  it("app home、general 与重叠登记在全部项目面上回 403", async () => {
    await register(home, "home-self");
    await register(root, "home-parent");
    await register(path.join(home, "projects"), "home-child");

    for (const name of ["general", home, root, "home-self", "home-parent", "home-child"]) {
      for (const [surface, suffix, init] of PROJECT_SURFACES) {
        const response = await request(name, suffix, init());
        expect(response.status, `${name} → ${surface} 应为 403`).toBe(403);
        const body = await response.text();
        expect(body).not.toContain("fake-server-token");
      }
    }
  });

  it("app home 内的 server-token 与 sati.yaml 不可经任何项目面读出", async () => {
    await writeFile(path.join(home, "sati.yaml"), "apiKey: sk-secret");
    for (const name of ["general", home, "unknown", root, "-state"]) {
      for (const suffix of [
        "/file?filePath=server-token",
        "/file?filePath=sati.yaml",
        "/files/content?path=server-token",
      ]) {
        const response = await request(name, suffix);
        expect([403, 404], `${name} → ${suffix}`).toContain(response.status);
        const body = await response.text();
        expect(body).not.toContain("fake-server-token");
        expect(body).not.toContain("sk-secret");
      }
    }
  });

  it("越权尝试后 app home 内的 server-token 与工作区文件都原样保留", async () => {
    await request(root, "/file", { method: "PUT", body: { filePath: "marker", content: "changed" } });
    await request(home, "/files", { method: "DELETE", body: { path: "server-token" } });
    expect(await readFile(path.join(home, "server-token"), "utf8")).toBe("fake-server-token");
    await expect(readFile(path.join(root, "marker"), "utf8")).rejects.toThrow();
  });

  it("处理器不再按 projectName 解析 root", () => {
    expect(extractProjectDirectory).not.toHaveBeenCalled();
  });
});

describe("端到端：合法工作区照常可用", () => {
  it("按 id 与按工作区绝对路径两种形态都能读、写、列树、打包", async () => {
    await register(workspace, "demo");

    for (const name of ["demo", workspace]) {
      // 上一轮已把内容改成 edited —— 每轮先复位，否则第二轮读的是上一轮的写入
      await writeFile(path.join(workspace, "normal.txt"), "normal");
      const read = await request(name, "/file?filePath=normal.txt");
      expect(read.status, `${name} 读取`).toBe(200);
      expect((await read.json()).content).toBe("normal");

      const bytes = await request(name, "/files/content?path=normal.txt");
      expect(bytes.status, `${name} 字节`).toBe(200);
      expect(await bytes.text()).toBe("normal");

      const write = await request(name, "/file", {
        method: "PUT",
        body: { filePath: "normal.txt", content: "edited" },
      });
      expect(write.status, `${name} 写盘`).toBe(200);
      expect(await readFile(path.join(workspace, "normal.txt"), "utf8")).toBe("edited");

      const tree = await request(name, "/files");
      expect(tree.status, `${name} 文件树`).toBe(200);
      expect((await tree.json()).some(entry => entry.name === "normal.txt")).toBe(true);

      const archive = await request(name, "/download");
      expect(archive.status, `${name} 打包`).toBe(200);
      expect(await archive.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
    }
    expect(extractProjectDirectory).not.toHaveBeenCalled();
  });

  it("上传落在工作区内", async () => {
    await register(workspace, "demo");
    const response = await request("demo", "/files/upload", {
      method: "POST",
      raw: formData("new.txt", "uploaded"),
    });
    expect(response.status).toBe(200);
    expect(await readFile(path.join(workspace, "new.txt"), "utf8")).toBe("uploaded");
  });

  // General 的 root 是 app home，因此被重叠判定拒掉——但聊天附件面从不解析请求方给的路径，
  // 只在 root 下写服务端构造的 `.tmp/chat-attachments/<ts>-<rand>/`，故该面单独放行重叠判定。
  // 不放行的话，General 会话里任何附件都会 403（本批唯一会打断正常使用的退化）。
  it("General 的聊天附件仍可上传，且落在服务端构造的目录内", async () => {
    const response = await request("general", "/upload-attachments", {
      method: "POST",
      raw: attachmentForm("note.txt", "attached"),
    });

    expect(response.status).toBe(200);
    const { files } = await response.json();
    expect(files).toHaveLength(1);
    expect(files[0].path.startsWith(path.join(home, ".tmp", "chat-attachments"))).toBe(true);
    expect(await readFile(files[0].path, "utf8")).toBe("attached");
  });

  it("工作区被删除后回 404（登记仍在）", async () => {
    await register(workspace, "demo");
    expect((await request("demo", "/file?filePath=normal.txt")).status).toBe(200);
    await rm(workspace, { recursive: true });
    expect((await request("demo", "/file?filePath=normal.txt")).status).toBe(404);
  });
});

describe("接线契约：每个项目面都挂守卫", () => {
  /**
   * 每个路由文件里 `/api/projects/:projectName/…` 面的条数。条数为 0 时下面的循环恒真，
   * 故先钉住条数，避免「解析失败 = 断言通过」。
   */
  const PROJECT_FACE_COUNTS = [
    ["project-files.js", 5],
    ["project-preview.js", 6],
    ["project-uploads.js", 3],
  ];

  /**
   * 按设计不挂守卫的项目面：`upload-images` 只用 `req.user.id` 与临时目录，从不解析项目
   * root，也就没有需要授权的 root（它同时也没有任何源码消费方）。
   */
  const UNGUARDED_BY_DESIGN = new Map([["project-uploads.js", new Set(["/api/projects/:projectName/upload-images"])]]);

  /**
   * 两个守卫都只认注册表 root，区别仅在是否放行与 app home 重叠；后者只允许出现在**不接受
   * 请求方所选路径**的面上（`requireChatAttachmentRoot` 的来由见该路由的注释）。
   */
  const GUARD_NAMES = ["requireRegisteredProjectRoot", "requireChatAttachmentRoot"];

  const OVERLAP_PERMITTING_GUARD = "requireChatAttachmentRoot";

  function projectFaces(file) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const matches = [
      ...source.matchAll(
        /router\.(?:get|post|put|delete|patch)\(\s*(?:\n\s*)?"(\/api\/projects\/:projectName\/[^"]*)"/g,
      ),
    ];
    // 每个面的中间件链切到**下一个路由声明之前**为止。固定长度的窗口会溢到下一个路由的链上，
    // 让「这个面挂了哪个守卫」的断言出现假阳/假阴。
    return matches.map((match, index) => ({
      path: match[1],
      chain: source.slice(match.index, matches[index + 1]?.index ?? source.length),
    }));
  }

  it.each(PROJECT_FACE_COUNTS)("%s 的项目面共 %i 条，条数与接线一致", (file, expectedCount) => {
    expect(projectFaces(file).length).toBe(expectedCount);
  });

  it.each(PROJECT_FACE_COUNTS)("%s 的项目面都挂了守卫（豁免项需显式登记）", file => {
    const exempt = UNGUARDED_BY_DESIGN.get(file) ?? new Set();
    const unguarded = projectFaces(file)
      .filter(({ path: routePath }) => !exempt.has(routePath))
      .filter(({ chain }) => !GUARD_NAMES.some(name => chain.includes(name)))
      .map(({ path: routePath }) => routePath);
    expect(unguarded).toEqual([]);
  });

  // projectFaces 只认 `router.<verb>(\s*"…"` 这一种声明形态。若有人用 router.use / app.get /
  // 别的换行方式加新面，上面的条数断言不会变，那道面就会静默逃过守卫检查——故再按路径字面量
  // 总数钉一次（本批实测：三个文件的字面量数与扫描面数恰好相等）。
  it.each(PROJECT_FACE_COUNTS)("%s 的项目面字面量都被扫描覆盖（防新声明形态漏检）", file => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const literals = source.match(/\/api\/projects\/:projectName\//g) ?? [];
    expect(literals.length).toBe(projectFaces(file).length);
  });

  it("只有聊天附件面使用放行 app home 重叠的守卫", () => {
    const overlapFaces = [];
    for (const [file] of PROJECT_FACE_COUNTS) {
      for (const { path: routePath, chain } of projectFaces(file)) {
        if (chain.includes(OVERLAP_PERMITTING_GUARD)) {
          overlapFaces.push(`${file} ${routePath}`);
        }
      }
    }
    expect(overlapFaces).toEqual(["project-uploads.js /api/projects/:projectName/upload-attachments"]);
  });

  it("豁免清单不得包含已加守卫的路由（防豁免烂掉）", () => {
    for (const [file, exempt] of UNGUARDED_BY_DESIGN) {
      for (const { path: routePath, chain } of projectFaces(file)) {
        if (exempt.has(routePath)) {
          expect(chain, `${routePath} 已加守卫，应从豁免清单移除`).not.toContain("requireRegisteredProjectRoot");
        }
      }
    }
  });

  it.each(PROJECT_FACE_COUNTS)("%s 不再按 projectName 解析 root", file => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toContain("extractProjectDirectory");
    expect(source).not.toContain("Fallback to simple dash replacement");
  });
});
