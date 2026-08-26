import { describe, expect, it } from "vitest";
import type { BoardCard } from "../types/types";
import { applyMove, cardsByColumn, dropToGlobalIndex, getCard } from "./boardPosition";

function makeCard(id: string, columnId: string, title = id): BoardCard {
  return {
    id,
    columnId,
    title,
    note: "",
    label: "",
    priority: "medium",
    color: "#0ea5e9",
    archived: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

const c1 = { ...makeCard("k1", "c1"), columnId: "c1" };
const c2 = { ...makeCard("k2", "c1"), columnId: "c1" };
const c3 = { ...makeCard("k3", "c2"), columnId: "c2" };
const cards = [c1, c2, c3];

describe("cardsByColumn", () => {
  it("按列过滤并保持数组顺序", () => {
    expect(cardsByColumn(cards, "c1").map(card => card.id)).toEqual(["k1", "k2"]);
    expect(cardsByColumn(cards, "c2").map(card => card.id)).toEqual(["k3"]);
  });
});

describe("getCard", () => {
  it("按 id 查卡", () => {
    expect(getCard(cards, "k2")?.columnId).toBe("c1");
    expect(getCard(cards, "missing")).toBeUndefined();
  });
});

describe("dropToGlobalIndex", () => {
  it("over 指定卡时返回其在移除后被拖卡后的全局索引", () => {
    // 拖 k1 到 c2 的 k3 上方：移除 k1 后 k3 位于索引 1
    expect(dropToGlobalIndex(cards, "k1", "k3")).toBe(1);
  });

  it("over 为空 / undefined 时返回末尾", () => {
    expect(dropToGlobalIndex(cards, "k1", null)).toBe(cards.length - 1);
    expect(dropToGlobalIndex(cards, "k1")).toBe(cards.length - 1);
  });

  it("over 卡不存在时返回末尾", () => {
    expect(dropToGlobalIndex(cards, "k1", "does-not-exist")).toBe(cards.length - 1);
  });
});

describe("applyMove", () => {
  it("跨列移动：卡在目标列末尾追加（toIndex 未传）", () => {
    const next = applyMove(cards, "k1", "c2");
    expect(next.map(card => card.id)).toEqual(["k2", "k3", "k1"]);
    expect(next.find(card => card.id === "k1")?.columnId).toBe("c2");
  });

  it("列内重排：按 toIndex 插入到指定卡之前", () => {
    // 把 k2 移到 k1 之前（移除 k2 后 k1 在索引 0）
    const next = applyMove(cards, "k2", "c1", dropToGlobalIndex(cards, "k2", "k1"));
    expect(next.map(card => card.id)).toEqual(["k2", "k1", "k3"]);
  });

  it("toIndex 超出数组长度时 clamp 到末尾", () => {
    const next = applyMove(cards, "k1", "c1", 999);
    expect(next[next.length - 1]?.id).toBe("k1");
  });

  it("负数 toIndex clamp 到 0", () => {
    const next = applyMove(cards, "k3", "c2", -5);
    expect(next[0]?.id).toBe("k3");
  });

  it("卡不存在时返回原数组（不变对象）", () => {
    expect(applyMove(cards, "missing", "c2", 0)).toBe(cards);
  });

  it("更新 updatedAt", () => {
    const next = applyMove(cards, "k1", "c2", 1, "2026-09-01T00:00:00.000Z");
    expect(next.find(card => card.id === "k1")?.updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
