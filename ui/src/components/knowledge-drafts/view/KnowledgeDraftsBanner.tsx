import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { BookOpenText, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useKnowledgeDrafts } from "../hooks/useKnowledgeDrafts";
import type { KnowledgeDraft } from "../types/types";

/**
 * 知识草稿确认横幅（WS2，应用级：挂在主内容区之上）。
 *
 * 为什么需要它：草稿闸门默认开（D1）——agent 的 knowledge_note_save 只提交
 * pending 草稿，不经确认不进知识库。没有这个入口，浏览器用户只能手工 curl
 * /api/web/knowledge-drafts/confirm，闸门形同虚设。
 *
 * 只呈现 pending 草稿；全部处理完时不渲染任何东西（默认零占用）。
 * 文案可见正文：看不见内容的「确认」不算确认（与 HookTrustBanner 同纪律）。
 */
export function KnowledgeDraftsBanner(): JSX.Element | null {
  const { t } = useTranslation("knowledgeDrafts");
  const { pendingDrafts, error, busyDraftId, confirm, reject } = useKnowledgeDrafts();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (error !== null && pendingDrafts.length === 0) return null;
  if (pendingDrafts.length === 0) return null;
  if (dismissed) return null;

  return (
    <section
      data-testid="knowledge-drafts-banner"
      className="border-b border-sky-300 bg-sky-50 px-4 py-2 text-sm text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100"
    >
      <div className="flex flex-wrap items-center gap-2">
        <BookOpenText className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{t("title")}</span>
        <span className="text-sky-800 dark:text-sky-200">{t("subtitle", { count: pendingDrafts.length })}</span>
        <button
          type="button"
          data-testid="knowledge-drafts-expand"
          className="ml-1 inline-flex items-center gap-1 rounded border border-sky-400 px-2 py-0.5 hover:bg-sky-100 dark:border-sky-800 dark:hover:bg-sky-900/40"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
          {expanded ? t("collapse") : t("expand")}
        </button>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-sky-800 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900/40"
          onClick={() => setDismissed(true)}
        >
          {t("dismiss")}
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 space-y-3">
          {pendingDrafts.map(draft => (
            <KnowledgeDraftCard
              key={draft.id}
              draft={draft}
              busy={busyDraftId === draft.id}
              onConfirm={() => void confirm(draft.id)}
              onReject={() => void reject(draft.id)}
            />
          ))}
          <p className="text-xs text-sky-800 dark:text-sky-200">{t("footer")}</p>
        </div>
      ) : null}
    </section>
  );
}

function KnowledgeDraftCard({
  draft,
  busy,
  onConfirm,
  onReject,
}: {
  draft: KnowledgeDraft;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}): JSX.Element {
  const { t } = useTranslation("knowledgeDrafts");
  return (
    <div
      data-testid={`knowledge-drafts-entry-${draft.id}`}
      className="rounded border border-sky-300 bg-white/70 p-2 dark:border-sky-900/60 dark:bg-neutral-900/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{draft.title}</span>
        <span className="truncate font-mono text-xs text-sky-800 dark:text-sky-200" title={draft.sessionId}>
          {draft.sessionId}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid={`knowledge-drafts-confirm-${draft.id}`}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
            onClick={onConfirm}
          >
            <Check className="size-3.5" aria-hidden="true" />
            {t("confirm")}
          </button>
          <button
            type="button"
            data-testid={`knowledge-drafts-reject-${draft.id}`}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-sky-400 px-2 py-0.5 text-xs hover:bg-sky-100 disabled:opacity-50 dark:border-sky-800 dark:hover:bg-sky-900/40"
            onClick={onReject}
          >
            <X className="size-3.5" aria-hidden="true" />
            {t("reject")}
          </button>
        </div>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-all text-xs">{draft.content}</p>
    </div>
  );
}
