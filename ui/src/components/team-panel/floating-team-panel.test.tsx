// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../utils/api";
import type { WsMessage } from "../../contexts/WebSocketContext";
import { TEAM_PANEL_COLLAPSED_KEY, TEAM_PANEL_SETTLE_MS } from "./constants";
import { FloatingTeamPanel } from "./floating-team-panel";
import type { PanelActionResult, TeamPanelSnapshot } from "./types";

// mock 手法照抄 useTeamPanel.test.tsx / use-team-activity.test.ts：vi.mock 注入
// authenticatedFetch（自造 { ok, json } 响应对象）+ 稳定 subscribe 引用。
const { subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn<(handler: (msg: WsMessage) => void) => () => void>(() => vi.fn()),
}));

vi.mock("../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("../../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ ws: null, sendMessage: vi.fn(), subscribe }),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

// 两个团队：team_1 单任务、team_2 含依赖链（t_a → t_b）供 DAG/会话跟随断言。
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
          modelRoute: {},
          retired: false,
        },
      ],
      tasks: [
        {
          taskId: "t_1",
          subject: "检索对比文件",
          status: "completed",
          attempt: 1,
          dependencies: [],
          blockedByCount: 0,
        },
      ],
    },
    {
      id: "team_2",
      name: "OA答复组",
      captainSessionKey: "web:other",
      createdAt: "2026-08-20T10:05:00.000Z",
      captainOnline: true,
      members: [
        {
          memberId: "m_drafter",
          roleSlug: "drafter",
          status: "working",
          modelRoute: {},
          retired: false,
        },
      ],
      tasks: [
        {
          taskId: "t_a",
          subject: "解析OA",
          status: "in_progress",
          attempt: 1,
          dependencies: [],
          blockedByCount: 0,
          assigneeId: "m_drafter",
        },
        {
          taskId: "t_b",
          subject: "起草答复",
          status: "pending",
          attempt: 1,
          dependencies: ["t_a"],
          blockedByCount: 1,
        },
      ],
    },
  ],
};

/**
 * fake timers 版事件注入：React passive effects 经 setImmediate 调度（被 fake
 * 接管），handler 的 setState 与时钟推进须分属两个 act——同一 act 内 advance
 * 会打断 React 的 actQueue flush 链，导致自动展开 effect 不运行。
 */
async function emitFrameAsync(payload: unknown) {
  // 取最近一次 render 注册的 handler（calls 跨用例累积，calls[0] 可能是旧实例）
  const handler = subscribe.mock.calls.at(-1)?.[0];
  expect(handler).toBeTypeOf("function");
  act(() => handler?.(payload as WsMessage));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function renderPanel(props: Partial<React.ComponentProps<typeof FloatingTeamPanel>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <FloatingTeamPanel sessionId={null} docked={false} isMobile={false} onClose={onClose} {...props} />,
  );
  return { ...utils, onClose };
}

describe("FloatingTeamPanel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    subscribe.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("docked 冒烟：标题/队长卡/任务 DAG/成员树渲染，任务节点带 data-task-id", async () => {
    mockedFetch.mockResolvedValue(response(snapshotBody));
    const { container } = renderPanel({ docked: true });

    await waitFor(() => {
      expect(screen.getByText("panel.title")).toBeTruthy();
    });

    // 会话跟随缺省（sessionId=null）：选中第一活动团队（chips + 队长卡各一处）
    expect(screen.getAllByText("无效宣告组").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("t_1")).toBeTruthy();
    // DAG 节点（foreignObject 内 button）：仅断言 data-task-id 结构与数量
    expect(container.querySelectorAll("[data-task-id]")).toHaveLength(1);
    // 成员树默认折叠：标题可见，成员行不可见
    expect(screen.getByText("members.title")).toBeTruthy();
    expect(screen.queryByText("m_researcher")).toBeNull();
  });

  it("会话跟随：captainSessionKey 匹配当前会话的团队自动选中", async () => {
    mockedFetch.mockResolvedValue(response(snapshotBody));
    renderPanel({ sessionId: "web:other", docked: true });

    await waitFor(() => {
      // 选中态 = CaptainSummary 标题 + chips 各一处
      expect(screen.getAllByText("OA答复组").length).toBeGreaterThanOrEqual(2);
    });
    // team_2 的 DAG：t_a → t_b 两个节点
    expect(document.body.querySelectorAll("[data-task-id]")).toHaveLength(2);
  });

  it("空态：展示建队表单；创建失败 → 反馈横幅显示后端契约 message", async () => {
    mockedFetch.mockResolvedValue(response({ teams: [] }));
    renderPanel({ docked: true });

    await waitFor(() => {
      expect(screen.getByText("overview.noTeams")).toBeTruthy();
    });

    // action 失败分流：panel 正常、action 返回契约错误
    mockedFetch.mockImplementation((url: string) => {
      if (url === "/api/teams/panel") {
        return Promise.resolve(response(snapshotBody));
      }
      return Promise.resolve(
        response({
          ok: false,
          error: { code: "team_already_exists", message: "团队已存在" },
        } as PanelActionResult),
      );
    });

    fireEvent.change(screen.getByPlaceholderText("overview.createPlaceholder"), { target: { value: "新团队" } });
    fireEvent.click(screen.getByText("overview.create"));

    await waitFor(() => {
      expect(screen.getByText("团队已存在")).toBeTruthy();
    });
  });

  it("收起态：浮标显示团队数，无事件时无脉冲点；点击浮标展开", async () => {
    localStorage.setItem(TEAM_PANEL_COLLAPSED_KEY, "1");
    mockedFetch.mockResolvedValue(response(snapshotBody));
    renderPanel({ docked: true });

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalled();
    });

    // 浮标药丸 + 团队数（i18n mock 返回 key 本身）
    const pill = screen.getByLabelText("panel.pillExpand");
    expect(screen.getByText("pill.teamCount")).toBeTruthy();
    expect(screen.queryByLabelText("pill.newActivity")).toBeNull();

    fireEvent.click(pill);
    expect(screen.getByText("panel.title")).toBeTruthy();
  });

  it("自动展开状态机：settle 窗口内事件不展开，窗口后首条事件展开一次，手动收起后不再自动展开", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(TEAM_PANEL_COLLAPSED_KEY, "1");
      mockedFetch.mockResolvedValue(response(snapshotBody));
      renderPanel({ docked: true });

      // 首轮快照 fetch 完成
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByLabelText("panel.pillExpand")).toBeTruthy();

      // settle 窗口内（<4s）事件到达 → 不展开
      await emitFrameAsync({
        kind: "team_event",
        event: { type: "task_claimed", taskId: "t_b", memberId: "m_drafter" },
      });
      expect(screen.getByLabelText("panel.pillExpand")).toBeTruthy();

      // 窗口后首条事件 → 自动展开一次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEAM_PANEL_SETTLE_MS + 1);
      });
      await emitFrameAsync({
        kind: "team_event",
        event: { type: "task_completed", taskId: "t_b", memberId: "m_drafter" },
      });
      expect(screen.getByText("panel.title")).toBeTruthy();

      // 手动收起（userCollapsed 意图优先）→ 事件不再触发自动展开
      fireEvent.click(screen.getByLabelText("panel.collapse"));
      expect(screen.getByLabelText("panel.pillExpand")).toBeTruthy();
      await emitFrameAsync({
        kind: "team_event",
        event: { type: "task_retried", taskId: "t_b", memberId: "m_drafter" },
      });
      expect(screen.getByLabelText("panel.pillExpand")).toBeTruthy();

      // 点击浮标 → 重新激活展开
      fireEvent.click(screen.getByLabelText("panel.pillExpand"));
      expect(screen.getByText("panel.title")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("展开态按 ESC → 关闭回调", async () => {
    mockedFetch.mockResolvedValue(response(snapshotBody));
    const { onClose } = renderPanel({ docked: true });

    await waitFor(() => {
      expect(screen.getByText("panel.title")).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
