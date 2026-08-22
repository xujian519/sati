import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionGraphNode } from "../types";
import { useSessionTurns } from "../hooks/useSessionTurns";
import { ProcessTrace, type ProcessTraceStep } from "../../chat-v2/ProcessTrace";

export type SessionGraphDetailPanelProps = {
  node: SessionGraphNode;
  projectName?: string;
  isMobile?: boolean;
  onClose: () => void;
  onNavigateToSession?: (sessionId: string) => void;
};

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

function mapProcessToSteps(
  process: { callId: string; name: string; arguments?: string; result?: string; error?: string | null }[],
): ProcessTraceStep[] {
  return process.map(p => ({
    id: p.callId,
    title: p.name,
    detail: truncate(p.arguments || p.result || "", 120),
    state: p.error ? "failed" : "completed",
    severity: p.error ? "error" : undefined,
  }));
}

export function SessionGraphDetailPanel({
  node,
  projectName,
  isMobile,
  onClose,
  onNavigateToSession,
}: SessionGraphDetailPanelProps) {
  const { t } = useTranslation("sessionGraph");
  const { turns, loading, error, refetch } = useSessionTurns({ sessionId: node.sessionId, projectName });

  const containerClass = isMobile
    ? "fixed inset-x-0 bottom-0 z-50 h-[60vh] rounded-t-xl border-t bg-white shadow-2xl dark:bg-neutral-950"
    : "absolute top-16 right-4 bottom-4 z-20 w-96 rounded-xl border bg-white/95 shadow-lg backdrop-blur-sm dark:bg-neutral-900/95";

  const statusLabel = node.isReadOnly
    ? t("detail.readOnly")
    : node.status === "processing"
      ? t("detail.processing")
      : node.status === "interrupted"
        ? t("detail.interrupted")
        : undefined;

  return (
    <div data-session-graph-detail className={containerClass}>
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between border-b border-neutral-100 p-4 dark:border-neutral-800">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100" title={node.title}>
              {node.title}
            </h3>
            <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="tabular-nums">{node.sessionId}</span>
              {statusLabel ? (
                <span
                  className={`rounded-full px-1.5 py-0.5 ${
                    node.status === "interrupted"
                      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      : node.status === "processing"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                  }`}
                >
                  {statusLabel}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {onNavigateToSession ? (
              <button
                type="button"
                onClick={() => onNavigateToSession(node.sessionId)}
                className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                {t("toolbar.backToChat", { defaultValue: "Back to chat" })}
              </button>
            ) : null}
            <button
              type="button"
              data-session-graph-detail-close
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {node.parentSessionId && node.forkedFromTurnId ? (
            <div className="mb-4 rounded-lg border border-violet-100 bg-violet-50 p-3 text-xs text-violet-800 dark:border-violet-900/40 dark:bg-violet-900/20 dark:text-violet-200">
              {t("detail.forkPoint", { turnId: node.forkedFromTurnId.slice(0, 8) })}
              {node.forkPreview?.questionSnippet ? (
                <div className="mt-1 text-violet-600 dark:text-violet-300">
                  “{truncate(node.forkPreview.questionSnippet, 140)}”
                </div>
              ) : null}
            </div>
          ) : null}

          {loading ? (
            <div className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading…</div>
          ) : error ? (
            <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              <p>{t("detail.loadFailed")}</p>
              <button
                type="button"
                onClick={refetch}
                className="mt-2 rounded-md bg-red-100 px-2 py-1 text-xs font-medium hover:bg-red-200 dark:bg-red-900/40 dark:hover:bg-red-900/60"
              >
                {t("error.retry")}
              </button>
            </div>
          ) : turns.length === 0 ? (
            <div className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{t("detail.noTurns")}</div>
          ) : (
            <div className="space-y-4">
              {turns.map((turn, index) => (
                <div key={turn.turnId} className="space-y-2">
                  <ProcessTrace
                    label={truncate(turn.question || t("detail.turns"), 48)}
                    collapsedDetail={turn.answer ? truncate(turn.answer, 60) : undefined}
                    steps={mapProcessToSteps(turn.process)}
                    defaultExpanded={index === 0}
                  />
                  {turn.answer ? (
                    <div className="pl-5 text-xs leading-relaxed whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">
                      {turn.answer}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
