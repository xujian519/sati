// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADD_CONTENT_REFERENCE_EVENT } from "../../../types/contentReference";
import type { AnnotationMark } from "../../../types/annotationReference";
import { useAnnotationSubmit } from "./useAnnotationSubmit";

const saveAnnotation = vi.fn();
vi.mock("../utils/sidecar", () => ({
  saveAnnotation: (...args: unknown[]) => saveAnnotation(...args) as Promise<string>,
  readAnnotation: () => Promise.resolve(null),
}));

// jsdom 没有画布：光栅化与 data URL 都换成桩，从而能断言"哪条路径会去动画布"。
const rasterizePng = vi.fn();
vi.mock("../utils/export", async importOriginal => {
  const actual = await importOriginal<typeof import("../utils/export")>();
  return {
    ...actual,
    rasterizePng: (...args: unknown[]) => rasterizePng(...args) as Promise<Blob>,
    blobToDataUrl: () => Promise.resolve("data:image/png;base64,AA"),
  };
});

/** 已就绪的被标注面：提供种类、固有尺寸与审阅图底层。 */
const figureSurface = {
  kind: "figure-svg" as const,
  size: { width: 416, height: 141 },
  reviewMarkup:
    '<svg xmlns="http://www.w3.org/2000/svg" width="416" height="141"><rect width="416" height="141"/></svg>',
};

const marks: readonly AnnotationMark[] = [
  {
    id: "m1",
    kind: "arrow",
    color: "#e03131",
    points: [
      [0, 0],
      [10, 10],
    ],
    text: "这个标号指错了",
  },
];

/** 记录调用键的翻译器（键应为命名空间下的短键）。 */
function translator(): { t: (key: string, options?: { path?: string }) => string; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    t: (key: string, options?: { path?: string }) => {
      keys.push(key);
      return options?.path === undefined ? `t:${key}` : `t:${key}:${options.path}`;
    },
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const { t, keys } = translator();
  const onSaved = vi.fn();
  const hook = renderHook(() =>
    useAnnotationSubmit({
      projectName: "demo",
      targetPath: "/w/project/figures/inv-fig1.svg",
      relativePath: "figures/inv-fig1.svg",
      fileName: "inv-fig1.svg",
      mimeType: "image/svg+xml",
      surface: figureSurface,
      sha256: "c".repeat(64),
      hashAlgo: "sha256",
      marks,
      summary: "把标号都对齐一遍",
      createdAt: null,
      t,
      onSaved,
      ...overrides,
    }),
  );
  return { hook, keys, onSaved };
}

beforeEach(() => {
  saveAnnotation.mockReset();
  saveAnnotation.mockResolvedValue("/w/project/figures/inv-fig1.svg.annot.json");
  rasterizePng.mockReset();
  rasterizePng.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
});

describe("annotation submit", () => {
  it("saves the sidecar and reports it with the namespaced short keys", async () => {
    const { hook, keys, onSaved } = harness();

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(saveAnnotation).toHaveBeenCalledTimes(1);
    const [projectName, targetPath, document] = saveAnnotation.mock.calls[0] as [
      string,
      string,
      { marks: unknown[]; createdAt: string; target: { sha256: string; hashAlgo?: string } },
    ];
    expect(projectName).toBe("demo");
    expect(targetPath).toBe("/w/project/figures/inv-fig1.svg");
    expect(document.marks).toHaveLength(1);
    // 哈希算法随摘要一起落盘：非安全上下文的 FNV-1a 与 SHA-256 不可比，得能区分。
    expect(document.target).toMatchObject({ sha256: "c".repeat(64), hashAlgo: "sha256" });
    // 短键：全键会被视图注入的前缀再次前缀化，界面上就会显示键名而不是文案。
    expect(keys).toEqual(["saving", "saved"]);
    expect(hook.result.current.status).toEqual({
      tone: "ok",
      text: "t:saved:/w/project/figures/inv-fig1.svg.annot.json",
    });
    expect(onSaved).toHaveBeenCalledWith(document.createdAt);
    expect(hook.result.current.busy).toBeNull();
  });

  it("does nothing without a mark and never calls the server", async () => {
    const { hook } = harness({ marks: [] });
    await act(async () => {
      await hook.result.current.run(true);
    });
    expect(saveAnnotation).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBeNull();
  });

  it("saves without touching the canvas, because only sending needs the review image", async () => {
    const { hook } = harness();

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(saveAnnotation).toHaveBeenCalledTimes(1);
    expect(rasterizePng).not.toHaveBeenCalled();
    expect(hook.result.current.status?.tone).toBe("ok");
  });

  it("rasterizes the review image and hands the composer a reference when sending", async () => {
    const { hook } = harness();
    const references: unknown[] = [];
    const listener = (event: Event): void => {
      references.push((event as CustomEvent).detail);
    };
    window.addEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);

    try {
      await act(async () => {
        await hook.result.current.run(true);
      });
    } finally {
      window.removeEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);
    }

    expect(rasterizePng).toHaveBeenCalledTimes(1);
    const [svg, width, height] = rasterizePng.mock.calls[0] as [string, number, number, number];
    expect(svg).toContain(figureSurface.reviewMarkup);
    expect([width, height]).toEqual([416, 141]);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      selectionMode: "annotation",
      image: { name: "inv-fig1.svg.annotated.png", mimeType: "image/png" },
      annotation: {
        document: { target: { sha256: "c".repeat(64) } },
        sidecarPath: "/w/project/figures/inv-fig1.svg.annot.json",
      },
    });
    expect((references[0] as { image: { dataUrl: string } }).image.dataUrl).toBe("data:image/png;base64,AA");
    expect(hook.result.current.status).toEqual({ tone: "ok", text: "t:sent" });
  });

  it("marks the reference as an image-surface annotation when the surface is a raster", async () => {
    // 面种类决定引用落点与提示块纪律：栅格图必须落在 `image` 而不是 `figure` 上。
    const { hook } = harness({
      surface: {
        kind: "image",
        size: { width: 1200, height: 900 },
        reviewMarkup: '<image href="data:image/png;base64,AA"/>',
      },
    });
    const references: unknown[] = [];
    const listener = (event: Event): void => {
      references.push((event as CustomEvent).detail);
    };
    window.addEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);

    try {
      await act(async () => {
        await hook.result.current.run(true);
      });
    } finally {
      window.removeEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);
    }

    expect(references[0]).toMatchObject({
      locator: { surface: "image", width: 1200, height: 900 },
      annotation: { document: { target: { kind: "image" } } },
    });
  });

  it("surfaces a save failure instead of dropping the annotation silently", async () => {
    saveAnnotation.mockRejectedValue(new Error("EACCES"));
    const { hook } = harness();

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(hook.result.current.status).toEqual({ tone: "error", text: "t:failedEACCES" });
    expect(hook.result.current.busy).toBeNull();
  });

  it("refuses to send before the surface is ready", async () => {
    const { hook, keys } = harness({ surface: undefined, sha256: undefined });

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(saveAnnotation).not.toHaveBeenCalled();
    // 失败提示由「前缀 + notReady 原因」拼成，故 failed 也会被取用。
    expect(keys).toEqual(["saving", "notReady", "failed"]);
    expect(hook.result.current.status?.tone).toBe("error");
  });
});
