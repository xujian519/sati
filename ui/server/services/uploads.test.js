// @vitest-environment node
import express from "express";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "sati-upload-workspace-"));
  tempDirs.push(workspace);
});

afterEach(() => {
  vi.doUnmock("../projects.js");
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createUploadApp() {
  vi.doMock("../projects.js", () => ({
    extractProjectDirectory: vi.fn(async () => workspace),
  }));
  const { uploadFilesHandler } = await import("./uploads.js");
  const app = express();
  app.post("/api/projects/:projectName/files/upload", uploadFilesHandler);
  return app;
}

/** 走真实 multipart 请求，避免绕过 multer 与路径校验。 */
async function upload(app, files, { targetPath = "", relativePaths } = {}) {
  const formData = new FormData();
  formData.append("targetPath", targetPath);
  if (relativePaths) {
    formData.append("relativePaths", JSON.stringify(relativePaths));
  }
  for (const file of files) {
    formData.append("files", new Blob([file.content], { type: "text/plain" }), file.name);
  }

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/projects/demo/files/upload`, {
      method: "POST",
      body: formData,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe("工作区文件上传", () => {
  it("新文件正常落盘并返回 200", async () => {
    const app = await createUploadApp();
    const { status, body } = await upload(app, [{ name: "fresh.txt", content: "hello" }]);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.files.map(file => file.name)).toEqual(["fresh.txt"]);
    expect(readFileSync(join(workspace, "fresh.txt"), "utf8")).toBe("hello");
  });

  it("同名文件已存在时拒绝覆盖：409，且原文件内容不变", async () => {
    writeFileSync(join(workspace, "note.txt"), "original", "utf8");
    const app = await createUploadApp();

    const { status, body } = await upload(app, [{ name: "note.txt", content: "replacement" }]);

    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.conflicts).toEqual(["note.txt"]);
    expect(body.files).toEqual([]);
    expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("original");
  });

  it("部分冲突时返回 207：新文件落盘、同名文件保持原样", async () => {
    writeFileSync(join(workspace, "a.txt"), "keep", "utf8");
    const app = await createUploadApp();

    const { status, body } = await upload(app, [
      { name: "a.txt", content: "overwrite" },
      { name: "b.txt", content: "brand new" },
    ]);

    expect(status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.conflicts).toEqual(["a.txt"]);
    expect(body.files.map(file => file.name)).toEqual(["b.txt"]);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("brand new");
  });

  it("folder 上传按 relativePaths 建嵌套目录", async () => {
    const app = await createUploadApp();
    const { status, body } = await upload(app, [{ name: "c.txt", content: "nested" }], {
      relativePaths: ["sub/dir/c.txt"],
    });

    expect(status).toBe(200);
    expect(body.files.map(file => file.name)).toEqual(["sub/dir/c.txt"]);
    expect(readFileSync(join(workspace, "sub", "dir", "c.txt"), "utf8")).toBe("nested");
  });

  it("越界目标路径被拒绝并回报，不再静默跳过", async () => {
    const escapeName = `${workspace.split("/").pop()}-escape.txt`;
    const outside = join(dirname(workspace), escapeName);
    const app = await createUploadApp();

    const { status, body } = await upload(app, [{ name: escapeName, content: "nope" }], {
      relativePaths: [`../${escapeName}`],
    });

    expect(status).toBe(409);
    expect(body.files).toEqual([]);
    expect(body.errors).toEqual([
      { name: `../${escapeName}`, code: "INVALID_DESTINATION", message: "Path must be under project root" },
    ]);
    expect(existsSync(outside)).toBe(false);
  });
});
