import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types/types";
import { hasEquivalentUserMessage, resolveConversationScrollTop } from "./useChatSessionState";

describe("resolveConversationScrollTop", () => {
  it("keeps a conversation pinned to the bottom when it was near the bottom", () => {
    expect(resolveConversationScrollTop({ top: 720, distanceFromBottom: 20 }, 1200, 400)).toBe(800);
  });

  it("restores an earlier reading position away from the bottom", () => {
    expect(resolveConversationScrollTop({ top: 320, distanceFromBottom: 480 }, 1200, 400)).toBe(320);
  });

  it("clamps a stored position when the transcript becomes shorter", () => {
    expect(resolveConversationScrollTop({ top: 900, distanceFromBottom: 200 }, 700, 400)).toBe(300);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 乐观用户气泡判重（上游 #570 切片）
//
// 旧判据只看「归一化文本 + 图片数 + 附件名」，同一文本连发两次时第二次会被判成
// 重复而**吞掉气泡**。两侧都带 turnId/runId 时以它为身份。
// ────────────────────────────────────────────────────────────────────────────

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { type: "user", content: "同一句话", timestamp: "2026-09-16T00:00:00.000Z", ...overrides };
}

describe("hasEquivalentUserMessage", () => {
  it("文本相同但 turnId 不同 → 不判重复（第二次的气泡不被吞）", () => {
    const rendered = [userMessage({ turnId: "turn-1", runId: "run-1" })];
    const pending = userMessage({ turnId: "turn-2", runId: "run-2" });

    expect(hasEquivalentUserMessage(rendered, pending)).toBe(false);
  });

  it("文本相同且 turnId 相同 → 判重复（乐观气泡与已落盘的同一条消息）", () => {
    const rendered = [userMessage({ turnId: "turn-1" })];
    const pending = userMessage({ turnId: "turn-1" });

    expect(hasEquivalentUserMessage(rendered, pending)).toBe(true);
  });

  it("两侧都缺 id 时才退回内容比较（旧行为）", () => {
    const sameText = [userMessage({ content: "同一句话" })];

    expect(hasEquivalentUserMessage(sameText, userMessage({ content: "同一句话" }))).toBe(true);
    expect(hasEquivalentUserMessage(sameText, userMessage({ content: "另一句话" }))).toBe(false);
  });

  it("只有一侧带 id → 不判重复（身份不可比时宁可多一条气泡）", () => {
    const sameText = [userMessage({ content: "同一句话" })];

    expect(hasEquivalentUserMessage(sameText, userMessage({ turnId: "turn-9" }))).toBe(false);
    expect(hasEquivalentUserMessage([userMessage({ turnId: "turn-9" })], userMessage({ content: "同一句话" }))).toBe(
      false,
    );
  });

  it("无 turnId 时仍按图片数与附件名区分", () => {
    const withImage = [userMessage({ images: [{ data: "data:image/png;base64,x" } as never] })];

    expect(hasEquivalentUserMessage(withImage, userMessage())).toBe(false);
    expect(hasEquivalentUserMessage(withImage, userMessage({ images: [{ data: "y" } as never] }))).toBe(true);
  });

  it("非用户消息不参与比较", () => {
    const assistant = [userMessage({ type: "assistant" })];

    expect(hasEquivalentUserMessage(assistant, userMessage())).toBe(false);
  });
});
