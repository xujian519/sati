import { describe, expect, it } from "vitest";
import {
  CONTEXT_RADIUS,
  buildSurroundingText,
  getClosestElement,
  getOccurrenceIndex,
  getSelectedPageNumbers,
  getTextLayerText,
  normalizeText,
} from "./pdfTextSelection";

function buildPages(pageTexts: Record<number, string>): HTMLDivElement {
  const root = document.createElement("div");
  for (const [pageNumber, text] of Object.entries(pageTexts)) {
    const page = document.createElement("div");
    page.dataset.pdfPageNumber = pageNumber;
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.textContent = text;
    page.append(textLayer);
    root.append(page);
  }
  return root;
}

describe("normalizeText", () => {
  it("折叠空白并裁剪两端", () => {
    expect(normalizeText("  a\n\n b\tc ")).toBe("a b c");
    expect(normalizeText("")).toBe("");
  });
});

describe("buildSurroundingText", () => {
  it("命中时取选中文本两侧各 CONTEXT_RADIUS 的窗口", () => {
    const documentText = `${"前".repeat(CONTEXT_RADIUS + 50)}关键词${"后".repeat(CONTEXT_RADIUS + 50)}`;
    const surrounding = buildSurroundingText(documentText, "关键词");

    expect(surrounding).toContain("关键词");
    expect(surrounding.length).toBe("关键词".length + 2 * CONTEXT_RADIUS);
    expect(surrounding.startsWith("前")).toBe(true);
    expect(surrounding.endsWith("后")).toBe(true);
  });

  it("文档开头的选中不会被裁到负下标，窗口贴左边界", () => {
    const surrounding = buildSurroundingText(`关键词${"后".repeat(CONTEXT_RADIUS * 2)}`, "关键词");

    expect(surrounding.startsWith("关键词")).toBe(true);
    // 左边界顶到头：只往右取一个 CONTEXT_RADIUS 的窗口。
    expect(surrounding.length).toBe("关键词".length + CONTEXT_RADIUS);
  });

  it("空白差异不影响命中（两侧都归一化）", () => {
    expect(buildSurroundingText("a b c", "  a   b  ")).toBe("a b c");
  });

  it("未命中时退回归一化后的选中文本", () => {
    expect(buildSurroundingText("无关内容", " 找不到 ")).toBe("找不到");
  });

  it("任一侧为空 → 空串", () => {
    expect(buildSurroundingText("", "x")).toBe("");
    expect(buildSurroundingText("x", "   ")).toBe("");
  });
});

describe("getOccurrenceIndex", () => {
  it("出现 → 1，未出现/空 → null", () => {
    expect(getOccurrenceIndex("第 1 页 第 2 页", "第 2 页")).toBe(1);
    expect(getOccurrenceIndex("第 1 页", "第 9 页")).toBeNull();
    expect(getOccurrenceIndex("", "x")).toBeNull();
    expect(getOccurrenceIndex("x", "")).toBeNull();
  });

  it("同名文本出现两次仍记 1（不区分数次出现，既有行为）", () => {
    expect(getOccurrenceIndex("关键词 关键词", "关键词")).toBe(1);
  });
});

describe("getTextLayerText / getSelectedPageNumbers", () => {
  it("指定页码时只取这些页；不看页时按 DOM 顺序全取并用换行拼接", () => {
    const root = buildPages({ 1: "第一页", 2: "第二页", 3: "" });

    expect(getTextLayerText(root, [2])).toBe("第二页");
    expect(getTextLayerText(root, [3, 1])).toBe("第一页");
    expect(getTextLayerText(root, [])).toBe("第一页\n第二页");
  });

  it("页码不存在时跳过而不是报错", () => {
    const root = buildPages({ 1: "第一页" });

    expect(getTextLayerText(root, [7])).toBe("");
  });

  it("按 Range 命中的页返回页码", () => {
    const root = buildPages({ 1: "第一页", 2: "第二页" });
    const range = document.createRange();
    range.selectNodeContents(root.querySelector<HTMLElement>('[data-pdf-page-number="2"]') as HTMLElement);

    expect(getSelectedPageNumbers(root, range)).toEqual([2]);
  });
});

describe("getClosestElement", () => {
  it("元素节点返回自身，文本节点返回父元素", () => {
    const parent = document.createElement("div");
    const text = document.createTextNode("hi");
    parent.append(text);

    expect(getClosestElement(parent)).toBe(parent);
    expect(getClosestElement(text)).toBe(parent);
  });
});
