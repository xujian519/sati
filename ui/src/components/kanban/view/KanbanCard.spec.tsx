// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { BoardCard } from "../types/types";
import { KanbanCard } from "./KanbanCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === "string" ? options.defaultValue : _key,
  }),
}));

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "k1",
    columnId: "c1",
    title: "实现 X 模块",
    note: "",
    label: "",
    priority: "medium",
    color: "#0ea5e9",
    archived: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(card: BoardCard, onOpen = vi.fn(), onOpenSource = vi.fn()) {
  return render(
    <DndContext>
      <SortableContext items={[card.id]} strategy={verticalListSortingStrategy}>
        <KanbanCard card={card} onOpen={onOpen} onOpenSource={onOpenSource} />
      </SortableContext>
    </DndContext>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KanbanCard", () => {
  it("无 source 时不显示源会话链接", () => {
    renderCard(makeCard());
    expect(screen.queryByRole("button", { name: /源会话/ })).toBeNull();
  });

  it("有 source 时渲染源会话链接并触发 onOpenSource", () => {
    const onOpen = vi.fn();
    const onOpenSource = vi.fn();
    renderCard(
      makeCard({ source: { sessionKey: "s-1", turnId: "t-1", at: "2026-08-26T00:00:00.000Z" } }),
      onOpen,
      onOpenSource,
    );

    // 卡片本体因 useSortable 带 role="button"，其可访问名含全文，故用精确 aria-label 定位源链接按钮
    const link = screen.getByRole("button", { name: "打开源会话" });
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    // 点击源会话链接不触发打开编辑器
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("点击卡片本体触发 onOpen", () => {
    const onOpen = vi.fn();
    renderCard(makeCard(), onOpen);
    fireEvent.click(screen.getByText("实现 X 模块"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
