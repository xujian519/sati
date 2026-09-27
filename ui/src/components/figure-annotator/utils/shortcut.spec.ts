import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./shortcut";

describe("annotator shortcuts", () => {
  it("keeps its hands off the editable controls the user is typing in", () => {
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    // 直接用属性（jsdom 不实现 `contentEditable` 的 IDL 反射）。
    editable.setAttribute("contenteditable", "true");
    expect(isTypingTarget(editable)).toBe(true);
    editable.setAttribute("contenteditable", "");
    expect(isTypingTarget(editable)).toBe(true);
    editable.setAttribute("contenteditable", "false");
    expect(isTypingTarget(editable)).toBe(false);
  });

  it("takes over everywhere else, including when the event carries no element", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("svg"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
