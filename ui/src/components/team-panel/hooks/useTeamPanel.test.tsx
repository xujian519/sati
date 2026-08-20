import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../../utils/api";
import { TEAM_PANEL_POLL_MS } from "../constants";
import type { PanelActionResult, TeamPanelSnapshot } from "../types";
import { useTeamPanel } from "./useTeamPanel";

// mock 形态对齐 useSatiConfig.test.tsx / useGatewayStatus.test.tsx：vi.mock 注入
// authenticatedFetch（自造 { ok, json } 响应对象，不依赖全局 fetch/Response）。
vi.mock("../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

// 自造 { ok, status, json } 响应对象，cast Response（对齐 useGatewayStatus.test.tsx 惯例）
function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

const snapshotBody: TeamPanelSnapshot = {
  teams: [
    {
      id: "team_1",
      name: "无效宣告组",
      captainSessionKey: "web:s_captain",
      createdAt: "2026-08-20T10:00:00.000Z",
      captainOnline: true,
      members: [
        {
          memberId: "m_researcher",
          roleSlug: "researcher",
          status: "idle",
          modelRoute: { provider: "anthropic", model: "claude" },
          retired: false,
        },
      ],
      tasks: [
        {
          taskId: "t_1",
          subject: "检索对比文件",
          status: "done",
          attempt: 1,
          dependencies: [],
          blockedByCount: 0,
        },
      ],
      unreadForCaptain: 0,
    },
  ],
};

function panelCalls() {
  return mockedFetch.mock.calls.filter(([url]) => url === "/api/teams/panel");
}

describe("useTeamPanel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("加载快照并轮询刷新（unmount 后停止轮询）", async () => {
    vi.useFakeTimers();
    try {
      mockedFetch.mockResolvedValue(response(snapshotBody));
      const { result, unmount } = renderHook(() => useTeamPanel());

      // 首轮加载（flush 微任务）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.snapshot).toEqual(snapshotBody);
      expect(result.current.error).toBeNull();

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockedFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/teams/panel");
      expect(options.method).toBe("POST");
      expect(options.body).toBe(JSON.stringify({ sessionKey: undefined }));
      expect((options as RequestInit & { suppressServerErrorToast?: boolean }).suppressServerErrorToast).toBe(true);

      // 轮询刷新：推进一个周期 → 第二次 panel fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEAM_PANEL_POLL_MS);
      });
      expect(panelCalls()).toHaveLength(2);

      // unmount 后 clearInterval 生效，不再新增 fetch
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEAM_PANEL_POLL_MS * 2);
      });
      expect(panelCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("action 调用 POST /api/teams/action 并透传结果", async () => {
    const actionResult: PanelActionResult = { ok: true, data: { reassigned: true } };
    mockedFetch.mockResolvedValue(response(actionResult));

    const { result } = renderHook(() => useTeamPanel());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let out: PanelActionResult | undefined;
    await act(async () => {
      out = await result.current.callAction("team_reassign_task", {
        teamId: "team_1",
        taskId: "t_1",
        assigneeId: "m_drafter",
      });
    });

    expect(out).toEqual(actionResult);

    const actionCall = mockedFetch.mock.calls.find(([url]) => url === "/api/teams/action");
    expect(actionCall).toBeDefined();
    const [, actionOptions] = actionCall as [string, RequestInit];
    expect(actionOptions.method).toBe("POST");
    const body = JSON.parse(String(actionOptions.body));
    expect(body).toEqual({
      tool: "team_reassign_task",
      input: { teamId: "team_1", taskId: "t_1", assigneeId: "m_drafter" },
    });

    // 成功时立即 refresh（不等下一轮询）
    await waitFor(() => {
      expect(panelCalls()).toHaveLength(2);
    });
  });

  it("错误响应 → ok: false（快照 fetch 按路由分流不受污染）", async () => {
    const errorResult: PanelActionResult = {
      ok: false,
      error: { code: "team_not_captain", message: "x" },
    };
    mockedFetch.mockImplementation((url: string) => {
      if (url === "/api/teams/panel") {
        return Promise.resolve(response(snapshotBody));
      }
      return Promise.resolve(response(errorResult));
    });

    const { result } = renderHook(() => useTeamPanel());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let out: PanelActionResult | undefined;
    await act(async () => {
      out = await result.current.callAction("team_archive", { teamId: "team_1" });
    });

    expect(out?.ok).toBe(false);
    // 首次快照 fetch 拿到的是正常数据
    expect(result.current.snapshot).toEqual(snapshotBody);
  });

  it("快照失败 → error 置位；action 网络失败/HTTP 非 2xx → 抛给调用方", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useTeamPanel());

    await waitFor(() => {
      expect(result.current.error).toBe("network down");
    });
    expect(result.current.snapshot).toBeNull();

    // action 网络失败 → 原样抛出
    mockedFetch.mockRejectedValueOnce(new Error("action network down"));
    await expect(act(() => result.current.callAction("team_archive", { teamId: "team_1" }))).rejects.toThrow(
      "action network down",
    );

    // action HTTP 非 2xx → 包装为 Error（M2：防 HTML 落 response.json() 未包装）
    mockedFetch.mockResolvedValueOnce(response({}, false, 500));
    await expect(act(() => result.current.callAction("team_archive", { teamId: "team_1" }))).rejects.toThrow(
      "团队面板操作失败: HTTP 500",
    );
  });
});
