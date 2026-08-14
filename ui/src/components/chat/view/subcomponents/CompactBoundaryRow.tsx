import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { ChatMessage, CompactBoundaryShadowedMessage } from "../../types/types";

/**
 * 压缩边界行：分隔线 + 标签 + token 前后对比 + 「展开压缩前原文」交互。
 * 从 MessageComponent.tsx 拆出（该文件跨过 1k 行红线）。
 */
export function CompactBoundaryRow({
  message,
  formattedTime,
  shadowedOpen,
  onToggleShadowed,
  t,
}: {
  message: ChatMessage;
  formattedTime: string;
  shadowedOpen: boolean;
  onToggleShadowed: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const shadowedMessages = Array.isArray(message.shadowedMessages) ? message.shadowedMessages : [];
  const shadowedCount = shadowedMessages.length;
  const shadowedDiagnostics = Array.isArray(message.shadowedDiagnostics) ? message.shadowedDiagnostics : [];
  return (
    <div className="my-2 flex w-full flex-col items-center gap-1.5 px-3 sm:px-0">
      <div className="flex w-full items-center justify-center gap-2">
        <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-900/50" />
        <span className="rounded-full border border-emerald-200/80 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-emerald-700 uppercase dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300">
          {t("compact.label")}
        </span>
        {typeof message.preTokens === "number" && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {typeof message.postTokens === "number"
              ? t("compact.tokensAfter", {
                  before: message.preTokens.toLocaleString(),
                  after: message.postTokens.toLocaleString(),
                })
              : t("compact.tokens", { tokens: message.preTokens.toLocaleString() })}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground tabular-nums">{formattedTime}</span>
        <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-900/50" />
      </div>
      {shadowedDiagnostics.length > 0 ? (
        <div className="flex w-full max-w-2xl items-start gap-1.5 rounded-md border border-amber-300/60 bg-amber-50/70 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          <span aria-hidden>⚠</span>
          <span>
            {t("compact.shadowedAlignmentWarning", { defaultValue: "部分压缩前历史无法完整还原（索引对齐告警）" })}
          </span>
        </div>
      ) : null}
      {shadowedCount > 0 ? (
        <button
          type="button"
          onClick={onToggleShadowed}
          aria-expanded={shadowedOpen}
          className="rounded-full border border-border/60 bg-muted/30 px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {shadowedOpen
            ? t("compact.hideShadowed", { defaultValue: "隐藏压缩前原文" })
            : t("compact.showShadowed", {
                count: shadowedCount,
                defaultValue: "展开压缩前 {{count}} 条消息",
              })}
        </button>
      ) : null}
      {shadowedOpen && shadowedCount > 0 ? (
        <div className="w-full max-w-2xl rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("compact.shadowedTitle", { defaultValue: "压缩前历史（原文）" })}
          </div>
          <div className="flex flex-col">
            {shadowedMessages.map((shadowed, index) => (
              <CompactBoundaryShadowedMessageRow key={shadowed.id ?? `shadowed-${index}`} message={shadowed} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 单条被遮蔽原文的只读展示（text/thinking/tool_use/tool_result + 图片）。 */
function CompactBoundaryShadowedMessageRow({ message }: { message: CompactBoundaryShadowedMessage }) {
  const roleLabel =
    message.role === "user"
      ? "USER"
      : message.kind === "tool_use" || message.kind === "tool_result"
        ? "TOOL"
        : "ASSISTANT";
  const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : "";
  let body: ReactNode;
  switch (message.kind) {
    case "text":
      body = <div className="text-[13px] whitespace-pre-wrap text-foreground">{message.text}</div>;
      break;
    case "thinking":
      body = <div className="text-[13px] text-muted-foreground italic">{message.text}</div>;
      break;
    case "tool_use":
      body = (
        <div className="text-[13px] font-medium text-foreground">
          {toolNameLabel(message.toolName)}
          {message.toolCallId ? (
            <span className="ml-1.5 text-[11px] text-muted-foreground">{message.toolCallId}</span>
          ) : null}
        </div>
      );
      break;
    case "tool_result":
      body = (
        <div className="max-h-40 overflow-y-auto text-[12px] whitespace-pre-wrap text-muted-foreground">
          {message.ok === false ? `⚠ ${message.text ?? ""}` : message.text}
        </div>
      );
      break;
    default:
      body = message.text ? <div className="text-[12px] text-muted-foreground">{message.text}</div> : null;
  }
  const images = Array.isArray(message.images) ? message.images.filter(image => typeof image.data === "string") : [];
  return (
    <div className="flex gap-2 border-b border-border/40 py-1.5 last:border-b-0">
      <span className="w-14 shrink-0 pt-px text-right text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {roleLabel}
      </span>
      <div className="min-w-0 flex-1">
        {body}
        {images.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {images.map((image, index) => (
              <img
                key={image.name ?? index}
                src={image.data}
                alt={image.name ?? "Shadowed image"}
                className="h-auto max-h-40 max-w-[160px] rounded border border-border/60 object-contain"
              />
            ))}
          </div>
        ) : null}
      </div>
      {time ? <span className="shrink-0 pt-px text-[10px] text-muted-foreground">{time}</span> : null}
    </div>
  );
}

function toolNameLabel(toolName?: string): string {
  const aliases: Record<string, string> = {
    bash: "Bash",
    edit_file: "Edit",
    read_file: "Read",
    grep: "Grep",
    glob: "Glob",
    write_file: "Write",
    agent: "Task",
  };
  return aliases[toolName ?? ""] ?? toolName ?? "Tool";
}
