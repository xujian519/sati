import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PendingApproval } from "../../types/types";

interface ApprovalRequestsBannerProps {
  pendingApprovals: PendingApproval[];
  handleApprovalDecision: (approval: PendingApproval, verdict: "adopted" | "rejected", feedback?: string) => void;
}

/**
 * 输出门禁 HITL 审批卡片：命中审批词的专利结论挂起等待人工审批。
 * 通过 = 流程控制完成（消息已入库）；拒绝 = 移除挂起并记录理由（可选）。
 */
export default function ApprovalRequestsBanner({
  pendingApprovals,
  handleApprovalDecision,
}: ApprovalRequestsBannerProps) {
  const { t } = useTranslation("chat");
  const [feedback, setFeedback] = useState<Record<number, string>>({});

  if (!pendingApprovals.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {pendingApprovals.map(approval => (
        <div
          key={approval.pendingIndex}
          className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 shadow-xs dark:border-indigo-800 dark:bg-indigo-900/20"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">
                {t("approvalBanner.title")}
              </div>
              <div className="mt-0.5 text-xs text-indigo-700 dark:text-indigo-300">
                {t("approvalBanner.trigger")} <span className="font-mono">{approval.triggerKeyword}</span>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">
              {t("approvalBanner.pending")}
            </span>
          </div>

          {approval.textPreview && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-indigo-800 hover:text-indigo-900 dark:text-indigo-200 dark:hover:text-indigo-100">
                {t("approvalBanner.viewMessage")}
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-indigo-200/60 bg-white/80 p-2 text-xs whitespace-pre-wrap text-indigo-900 dark:border-indigo-800/60 dark:bg-gray-900/60 dark:text-indigo-100">
                {approval.textPreview}
              </pre>
            </details>
          )}

          <div className="mt-3">
            <input
              type="text"
              value={feedback[approval.pendingIndex] ?? ""}
              onChange={event => setFeedback(prev => ({ ...prev, [approval.pendingIndex]: event.target.value }))}
              placeholder={t("approvalBanner.feedbackPlaceholder")}
              className="mb-2 w-full rounded-md border border-indigo-200 bg-white/80 px-2.5 py-1.5 text-xs text-indigo-900 placeholder:text-indigo-400 focus:border-indigo-400 focus:outline-none dark:border-indigo-800 dark:bg-gray-900/60 dark:text-indigo-100 dark:placeholder:text-indigo-600"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleApprovalDecision(approval, "adopted")}
                className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
              >
                {t("approvalBanner.approve")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const reason = feedback[approval.pendingIndex]?.trim() || undefined;
                  handleApprovalDecision(approval, "rejected", reason);
                }}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/30"
              >
                {t("approvalBanner.reject")}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
