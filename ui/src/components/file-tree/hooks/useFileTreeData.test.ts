// 「服务端按设计拒绝」（403，如 General 以 app home 为 root）与「项目确实没有文件」（200 + 空）
// 必须可区分：混同会向用户断言一个错误事实（面板写着「该项目为空。」，实际是拒绝访问）。
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/app";
import { useFileTreeData } from "./useFileTreeData";

const apiMock = vi.hoisted(() => ({ getFiles: vi.fn() }));

vi.mock("../../../utils/api", () => ({ api: apiMock }));
vi.mock("../../../utils/logging", () => ({ logError: vi.fn() }));

const project = { name: "general" } as Project;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("useFileTreeData 的不可用态", () => {
  beforeEach(() => {
    apiMock.getFiles.mockReset();
  });

  afterEach(cleanup);

  it("403 时标记 unavailable，而不是当成空项目", async () => {
    apiMock.getFiles.mockResolvedValue(
      jsonResponse({ error: { code: "PROJECT_PATH_FORBIDDEN", message: "unavailable" } }, 403),
    );

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.files).toEqual([]);
  });

  it("200 时给出文件并清掉 unavailable", async () => {
    apiMock.getFiles.mockResolvedValue(jsonResponse([{ name: "a.txt", path: "/w/a.txt", type: "file" }]));

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(result.current.unavailable).toBe(false);
  });

  it("空项目（200 + 空数组）不算 unavailable", async () => {
    apiMock.getFiles.mockResolvedValue(jsonResponse([]));

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.files).toEqual([]);
    expect(result.current.unavailable).toBe(false);
  });
});
