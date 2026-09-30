// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceUploadOutcome, type UploadHttpResponse } from "./workspaceUploadOutcome";

function makeResponse(payload: unknown, { ok = true, status = 200 } = {}): UploadHttpResponse {
  return {
    ok,
    status,
    json: async () => {
      if (payload === undefined) throw new Error("response body is not json");
      return payload;
    },
  };
}

const translate = (_key: string, options?: Record<string, unknown>): string => `conflict:${options?.names}`;

type Toast = { kind: string; message: string };

let listener: ((event: Event) => void) | undefined;

afterEach(() => {
  if (listener) window.removeEventListener("sati:toast", listener);
  listener = undefined;
  vi.restoreAllMocks();
});

function captureToasts(): Toast[] {
  const seen: Toast[] = [];
  listener = event => {
    const detail = (event as CustomEvent).detail as Toast;
    seen.push(detail);
  };
  window.addEventListener("sati:toast", listener);
  return seen;
}

describe("applyWorkspaceUploadOutcome", () => {
  it("成功时只刷新文件树", async () => {
    const refresh = vi.fn(async () => {});
    const toasts = captureToasts();

    await applyWorkspaceUploadOutcome(makeResponse({ success: true, files: [] }), { refresh, translate });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it("部分冲突（207）时刷新并提示被拒文件，不抛错", async () => {
    const refresh = vi.fn(async () => {});
    const toasts = captureToasts();

    await applyWorkspaceUploadOutcome(
      makeResponse({ success: false, files: [{ name: "b.txt" }], conflicts: ["a.txt"], errors: [] }, { status: 207 }),
      { refresh, translate },
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ kind: "error", message: "conflict:a.txt" }]);
  });

  it("全部冲突（409）时同样提示而不是抛错", async () => {
    const refresh = vi.fn(async () => {});
    const toasts = captureToasts();

    await applyWorkspaceUploadOutcome(
      makeResponse({ success: false, conflicts: ["a.txt"] }, { ok: false, status: 409 }),
      {
        refresh,
        translate,
      },
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
  });

  it("非冲突失败抛出后端消息且不刷新", async () => {
    const refresh = vi.fn(async () => {});
    captureToasts();

    await expect(
      applyWorkspaceUploadOutcome(makeResponse({ error: { code: "X", message: "boom" } }, { ok: false, status: 500 }), {
        refresh,
        translate,
      }),
    ).rejects.toThrow("boom");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("字符串错误体与不可解析响应体都给出可读消息", async () => {
    const refresh = vi.fn(async () => {});

    await expect(
      applyWorkspaceUploadOutcome(makeResponse({ error: "denied" }, { ok: false, status: 403 }), {
        refresh,
        translate,
      }),
    ).rejects.toThrow("denied");
    await expect(
      applyWorkspaceUploadOutcome(makeResponse(undefined, { ok: false, status: 502 }), { refresh, translate }),
    ).rejects.toThrow("Upload failed: 502");
  });
});
