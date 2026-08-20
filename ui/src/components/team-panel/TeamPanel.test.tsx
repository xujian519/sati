import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../utils/api";
import type { TeamPanelSnapshot } from "./types";
import { TeamPanel } from "./TeamPanel";

// mock 形态对齐 useTeamPanel.test.tsx / useSatiConfig.test.tsx：vi.mock 注入
// authenticatedFetch（自造 { ok, json } 响应对象）。react-i18next 已由根 vitest.setup.ts
// 全局 mock（t 返回 key 或 defaultValue），无需在此重复 mock。
vi.mock("../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** 快照 fixture：t1 团队（1 成员 researcher + 1 任务），对齐 useTeamPanel.test.tsx 形态。 */
const snapshotBody: TeamPanelSnapshot = {
  teams: [
    {
      id: "t1",
      name: "无效宣告组",
      captainSessionKey: "web:s_captain",
      createdAt: "2026-08-20T10:00:00.000Z",
      captainOnline: true,
      members: [
        {
          memberId: "m_researcher",
          roleSlug: "researcher",
          status: "working",
          modelRoute: { provider: "anthropic", model: "claude" },
          retired: false,
        },
      ],
      tasks: [
        {
          taskId: "task_1",
          subject: "检索对比文件",
          status: "in_progress",
          attempt: 2,
          dependencies: [],
          blockedByCount: 0,
          assigneeId: "m_researcher",
        },
      ],
      unreadForCaptain: 0,
    },
  ],
};

describe("TeamPanel", () => {
  afterEach(() => {
    cleanup();
    mockedFetch.mockReset();
  });

  it("渲染团队概览 + 成员 + 任务（冒烟）", async () => {
    mockedFetch.mockResolvedValue(response(snapshotBody));
    render(<TeamPanel />);

    // 团队卡（团队 id t1）
    expect(await screen.findByText(/t1/)).toBeDefined();
    // 成员 roleSlug 徽章（同时出现在添加成员下拉选项里，用 getAllByText 断言）
    expect(screen.getAllByText(/researcher/).length).toBeGreaterThan(0);
    // 任务 subject
    expect(screen.getByText(/检索对比文件/)).toBeDefined();
    // 事件流空态容器存在
    expect(screen.getByText(/events.empty/)).toBeDefined();
  });
});
