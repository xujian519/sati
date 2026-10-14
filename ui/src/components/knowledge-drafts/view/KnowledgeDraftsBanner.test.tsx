import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDraft } from "../types/types";
import { KnowledgeDraftsBanner } from "./KnowledgeDraftsBanner";

const list = vi.fn();
const confirmDraft = vi.fn();
const rejectDraft = vi.fn();

vi.mock("../../../utils/api", () => ({
  api: {
    knowledgeDrafts: {
      list: (...args: unknown[]) => list(...args) as Promise<unknown>,
      confirm: (...args: unknown[]) => confirmDraft(...args) as Promise<unknown>,
      reject: (...args: unknown[]) => rejectDraft(...args) as Promise<unknown>,
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

function draft(overrides: Partial<KnowledgeDraft> = {}): KnowledgeDraft {
  return {
    id: "draft-1",
    sessionId: "s1",
    title: "OA 答复要点",
    content: "创造性三步法论证框架",
    status: "pending",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    ...overrides,
  };
}

describe("KnowledgeDraftsBanner", () => {
  beforeEach(() => {
    list.mockReset();
    confirmDraft.mockReset();
    rejectDraft.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("无 pending 草稿时不渲染任何东西", async () => {
    list.mockResolvedValue({ drafts: [] });
    render(<KnowledgeDraftsBanner />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByTestId("knowledge-drafts-banner")).toBeNull();
  });

  it("有 pending 草稿时渲染计数与标题，展开后显示正文与确认/拒绝按钮", async () => {
    list.mockResolvedValue({ drafts: [draft()] });
    render(<KnowledgeDraftsBanner />);
    await waitFor(() => expect(screen.getByTestId("knowledge-drafts-banner")).toBeTruthy());
    expect(screen.getByText("subtitle:1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("knowledge-drafts-expand"));
    expect(screen.getByTestId("knowledge-drafts-entry-draft-1")).toBeTruthy();
    expect(screen.getByText("创造性三步法论证框架")).toBeTruthy();
    expect(screen.getByTestId("knowledge-drafts-confirm-draft-1")).toBeTruthy();
    expect(screen.getByTestId("knowledge-drafts-reject-draft-1")).toBeTruthy();
  });

  it("确认后调用 api 并刷新列表", async () => {
    list.mockResolvedValue({ drafts: [draft()] });
    confirmDraft.mockResolvedValue({ ok: true, documentId: "doc-1" });
    render(<KnowledgeDraftsBanner />);
    await waitFor(() => expect(screen.getByTestId("knowledge-drafts-banner")).toBeTruthy());

    fireEvent.click(screen.getByTestId("knowledge-drafts-expand"));
    fireEvent.click(screen.getByTestId("knowledge-drafts-confirm-draft-1"));
    await waitFor(() => expect(confirmDraft).toHaveBeenCalledWith("draft-1"));
    // confirm 后 refresh → 第二次 list 调用。
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("轮询：推进定时器触发周期性刷新", async () => {
    list.mockResolvedValue({ drafts: [] });
    vi.useFakeTimers();
    try {
      render(<KnowledgeDraftsBanner />);
      // 初始拉取在 mount effect 中同步发起；推进零时长刷新微任务。
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
