// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "../types/types";
import { KanbanCardEditor } from "./KanbanCardEditor";

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

const onSave = vi.fn(async () => ({ ok: true }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KanbanCardEditor", () => {
  it("新建模式：填写标题保存后视为新增并携带默认列", async () => {
    const onClose = vi.fn();
    render(<KanbanCardEditor card={null} defaultColumnId="c2" projects={[]} onSave={onSave} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("卡片标题"), { target: { value: "新卡片" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "新卡片", columnId: "c2" }));
  });

  it("新建模式：空标题不保存并提示错误", async () => {
    const onClose = vi.fn();
    render(<KanbanCardEditor card={null} defaultColumnId="c1" projects={[]} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await vi.waitFor(() => expect(screen.getByText("标题不能为空")).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("编辑模式：预填字段并显示复制/删除，不含恢复/彻底删除", () => {
    const card = makeCard({ title: "已有卡片", priority: "high", label: "feature" });
    render(<KanbanCardEditor card={card} defaultColumnId="c1" projects={[]} onSave={onSave} onClose={vi.fn()} />);

    expect(screen.getByDisplayValue("已有卡片")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "彻底删除" })).toBeNull();
  });

  it("回收站模式：显示恢复与彻底删除", () => {
    const card = makeCard({ archived: true });
    render(<KanbanCardEditor card={card} defaultColumnId="c1" projects={[]} onSave={onSave} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "恢复" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "彻底删除" })).toBeTruthy();
  });
});
