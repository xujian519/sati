import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelWindowOverrides } from "./useModelWindowOverrides";

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock("../../../../../utils/api", () => ({ authenticatedFetch: mocks.authenticatedFetch }));

afterEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe("useModelWindowOverrides (#449)", () => {
  it("首次渲染返回 null（尚未拿到），随后返回覆盖层条目", async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      jsonResponse({ exists: true, entries: { "relay/m": { maxContextTokens: 262144, source: "probe" } } }),
    );

    const { result } = renderHook(() => useModelWindowOverrides());
    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).toEqual({ "relay/m": { maxContextTokens: 262144, source: "probe" } });
    });
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      "/api/config/model-windows",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("文件不存在（exists:false）→ 空表而非 undefined", async () => {
    mocks.authenticatedFetch.mockResolvedValue(jsonResponse({ exists: false, entries: {} }));

    const { result } = renderHook(() => useModelWindowOverrides());

    await waitFor(() => {
      expect(result.current).toEqual({});
    });
  });

  it("请求失败或非 2xx → 空表（设置页退回未探测态，不显示不确定值）", async () => {
    mocks.authenticatedFetch.mockRejectedValue(new Error("boom"));
    const failing = renderHook(() => useModelWindowOverrides());
    await waitFor(() => {
      expect(failing.result.current).toEqual({});
    });

    mocks.authenticatedFetch.mockResolvedValue(jsonResponse({ error: "nope" }, false));
    const unauthorized = renderHook(() => useModelWindowOverrides());
    await waitFor(() => {
      expect(unauthorized.result.current).toEqual({});
    });
  });
});
