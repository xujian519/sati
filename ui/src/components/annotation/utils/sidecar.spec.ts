/**
 * sidecar 读回的候选顺序与归属校验。
 *
 * 守的是「同名不同扩展名」那条边界：v1 只按主名派生 sidecar，同目录的 `图3.svg` 与 `图3.png`
 * 会落到同一个文件上，不加归属校验就会把邻居的标注读成自己的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAnnotationDocument,
  type AnnotationDocument,
  type AnnotationTargetKind,
} from "../../../types/annotationReference";
import { readAnnotation, saveAnnotation } from "./sidecar";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), saveFile: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  api: { readFile: mocks.readFile, saveFile: mocks.saveFile },
}));

const DIR = "/w/提交件";
const SVG_PATH = `${DIR}/图3.svg`;
const PNG_PATH = `${DIR}/图3.png`;
const LEGACY_PATH = `${DIR}/图3.annot.json`;

const MEDIA_TYPES: Record<AnnotationTargetKind, string> = {
  "figure-svg": "image/svg+xml",
  image: "image/png",
  html: "text/html",
};

function documentFor(path: string, kind: AnnotationTargetKind): AnnotationDocument {
  return buildAnnotationDocument({
    target: {
      kind,
      path,
      relativePath: path,
      mediaType: MEDIA_TYPES[kind],
      width: 210,
      height: 297,
      sha256: "a".repeat(64),
    },
    marks: [],
  });
}

/** 让 `api.readFile` 只对给出的路径返回内容，其余按 404 处理。 */
function serveFiles(files: Record<string, AnnotationDocument>): void {
  mocks.readFile.mockImplementation(async (_project: string, path: string) => {
    const document = files[path];
    if (document === undefined) return { ok: false, json: async () => ({ error: "not_found" }) };
    return { ok: true, json: async () => ({ content: JSON.stringify(document) }) };
  });
}

const readPaths = () => mocks.readFile.mock.calls.map(call => call[1]);

describe("annotation sidecar read", () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.saveFile.mockReset();
  });

  it("reads the extension-qualified sidecar without falling back", async () => {
    serveFiles({ [`${SVG_PATH}.annot.json`]: documentFor(SVG_PATH, "figure-svg") });

    const document = await readAnnotation("proj", SVG_PATH);

    expect(document?.target.path).toBe(SVG_PATH);
    expect(readPaths()).toEqual([`${SVG_PATH}.annot.json`]);
  });

  it("falls back to the v1 main-name sidecar when it belongs to this file", async () => {
    serveFiles({ [LEGACY_PATH]: documentFor(SVG_PATH, "figure-svg") });

    const document = await readAnnotation("proj", SVG_PATH);

    expect(document?.target.path).toBe(SVG_PATH);
    expect(readPaths()).toEqual([`${SVG_PATH}.annot.json`, LEGACY_PATH]);
  });

  it("refuses a v1 sidecar that belongs to the same-named sibling", async () => {
    // 目录里只有 图3.annot.json（指向 .svg），而当前打开的是 .png。
    serveFiles({ [LEGACY_PATH]: documentFor(SVG_PATH, "figure-svg") });

    expect(await readAnnotation("proj", PNG_PATH)).toBeNull();
  });

  it("keeps looking when a candidate cannot be read at all", async () => {
    mocks.readFile.mockImplementation(async (_project: string, path: string) => {
      if (path === `${SVG_PATH}.annot.json`) throw new Error("network down");
      return { ok: true, json: async () => ({ content: JSON.stringify(documentFor(SVG_PATH, "figure-svg")) }) };
    });

    expect((await readAnnotation("proj", SVG_PATH))?.target.path).toBe(SVG_PATH);
  });

  it("reads nothing when no candidate exists", async () => {
    serveFiles({});

    expect(await readAnnotation("proj", PNG_PATH)).toBeNull();
  });
});

/**
 * 发布门控（D6）：`kind:"html"` 侧车的写入默认关闭。开启前任何写入都必须被拒绝——
 * 旧版读者读到未知 kind 会视为「从未标注」，并在保存时静默覆盖（H0 #6 实测，
 * 见 docs/notes/implemented/2026-10-08-html-annotation.md）。
 */
describe("html annotation write gate", () => {
  const HTML_PATH = `${DIR}/report.html`;

  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.saveFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to save an html sidecar while the gate is closed (default)", async () => {
    await expect(saveAnnotation("proj", HTML_PATH, documentFor(HTML_PATH, "html"))).rejects.toThrow(/not enabled/);
    expect(mocks.saveFile).not.toHaveBeenCalled();
  });

  it("saves the sidecar once the gate is enabled", async () => {
    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "true");
    mocks.saveFile.mockResolvedValue({ ok: true });

    await expect(saveAnnotation("proj", HTML_PATH, documentFor(HTML_PATH, "html"))).resolves.toBe(
      `${HTML_PATH}.annot.json`,
    );
    expect(mocks.saveFile).toHaveBeenCalledTimes(1);
  });

  it("leaves non-html surfaces untouched by the gate", async () => {
    mocks.saveFile.mockResolvedValue({ ok: true });

    await expect(saveAnnotation("proj", SVG_PATH, documentFor(SVG_PATH, "figure-svg"))).resolves.toBe(
      `${SVG_PATH}.annot.json`,
    );
  });
});
