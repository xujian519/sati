import type { GatewayEvent } from "../../../gateway/index.js";
import { renderPlainTextEvent } from "../protocol/render.js";

export type FeishuLiveCardActivityKind = "thinking" | "tool" | "subagent";

export type FeishuLiveCardOptions = {
  text: string;
  activityKind?: FeishuLiveCardActivityKind;
  isFinal?: boolean;
  fallbackText?: string;
  maxTextLength?: number;
};

const DEFAULT_LIVE_CARD_FALLBACK_TEXT = "处理完成，但没有可见回复。";
const DEFAULT_LIVE_CARD_MAX_TEXT_LENGTH = 4000;

export function renderFeishuLiveCard(options: FeishuLiveCardOptions): Record<string, unknown> {
  const isFinal = options.isFinal === true;
  const text = normalizeLiveCardText(options.text, {
    fallbackText: options.fallbackText ?? DEFAULT_LIVE_CARD_FALLBACK_TEXT,
    maxTextLength: options.maxTextLength ?? DEFAULT_LIVE_CARD_MAX_TEXT_LENGTH,
    useFallback: isFinal,
  });
  const elements: Array<Record<string, unknown>> = [];

  if (!isFinal) {
    elements.push(markdownElement(`**${activityLabel(options.activityKind ?? "thinking")}**`));
  }

  if (text) {
    elements.push(markdownElement(text));
  }

  return {
    config: { wide_screen_mode: false, update_multi: true },
    elements:
      elements.length > 0 ? elements : [markdownElement(options.fallbackText ?? DEFAULT_LIVE_CARD_FALLBACK_TEXT)],
  };
}

function normalizeLiveCardText(
  text: string,
  options: { fallbackText: string; maxTextLength: number; useFallback: boolean },
): string {
  const stripped = stripLiveCursor(text).trim();
  const visible = stripped || (options.useFallback ? options.fallbackText : "");
  if (visible.length <= options.maxTextLength) return visible;
  return `${visible.slice(0, Math.max(0, options.maxTextLength - 12)).trimEnd()}\n…（已截断）`;
}

function stripLiveCursor(text: string): string {
  return text.replace(/\s*▉\s*$/u, "");
}

function activityLabel(kind: FeishuLiveCardActivityKind): string {
  switch (kind) {
    case "tool":
      return "正在执行工具…";
    case "subagent":
      return "正在处理子任务…";
    case "thinking":
    default:
      return "正在思考…";
  }
}

function markdownElement(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content,
    },
  };
}

export function renderFeishuEvent(event: GatewayEvent): string | undefined {
  return renderPlainTextEvent(event, {
    toolFailureLabel: "执行失败",
    skipToolNames: new Set(["send_attachment"]),
    includeResultPreview: true,
  });
}
