// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRasterSource } from "./useRasterSource";

/**
 * jsdom 不解码图片：把 `Image` 换成"赋值 src 就回调 onload"的桩，从而能驱动尺寸解析。
 * 自然尺寸由 `naturalSize` 决定，用它模拟畸形图（0 尺寸）。
 */
let naturalSize = { width: 1200, height: 900 };

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1200;
  naturalHeight = 900;

  set src(_value: string) {
    this.naturalWidth = naturalSize.width;
    this.naturalHeight = naturalSize.height;
    queueMicrotask(() => {
      if (naturalSize.width > 0 && naturalSize.height > 0) this.onload?.();
      else this.onerror?.();
    });
  }
}

vi.stubGlobal("Image", FakeImage);

/** 一张最小的 PNG 字节（内容不重要，钩子只做哈希与解码）。 */
function pngBlob(): Blob {
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
}

// 必须是**同一个** Blob 实例：钩子的 effect 以 blob 身份为依赖，每次渲染都给新实例会形成
// 无限渲染循环（真实的 `useFileBlob` 把它存在 state 里，引用稳定）。
const PNG_BLOB = pngBlob();

function args(overrides: Partial<Parameters<typeof useRasterSource>[0]> = {}) {
  return {
    blob: PNG_BLOB,
    blobError: null,
    loading: false,
    failureMessage: "loadFailed",
    fileName: "page-1.png",
    enabled: true,
    ...overrides,
  };
}

afterEach(() => {
  naturalSize = { width: 1200, height: 900 };
});

describe("raster surface source", () => {
  it("reads the natural size, wraps the bytes as a data URL and hashes them", async () => {
    const { result } = renderHook(() => useRasterSource(args()));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    if (result.current.status !== "ready") throw new Error("expected a ready surface");
    expect(result.current.size).toEqual({ width: 1200, height: 900 });
    expect(result.current.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.current.sha256).toMatch(/^[0-9a-f]+$/);
    expect(["sha256", "fnv1a64"]).toContain(result.current.hashAlgo);
  });

  it("does no work while disabled, so the other surface can own the blob", async () => {
    const { result } = renderHook(() => useRasterSource(args({ enabled: false })));
    await Promise.resolve();
    expect(result.current.status).toBe("loading");
  });

  it("reports a zero-sized decode as an error instead of an unusable surface", async () => {
    naturalSize = { width: 0, height: 0 };
    const { result } = renderHook(() => useRasterSource(args()));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") throw new Error("expected an error surface");
    expect(result.current.message).toBe("loadFailed");
  });

  it("passes the read failure through instead of hiding it", async () => {
    const { result } = renderHook(() => useRasterSource(args({ blob: null, blobError: "boom" })));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") throw new Error("expected an error surface");
    expect(result.current.message).toBe("boom");
  });
});
