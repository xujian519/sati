import type { ActionFeedback } from "./hooks/useActionFeedback";

/**
 * 面板操作结果横幅（精简 C2 提取）：ok/error 双态配色。三视图组件原各 ~12 行重复 JSX
 * 收敛为一处；text 直接展示（经 useActionFeedback 收敛，不走 i18n）。
 */
export function FeedbackBanner({ feedback }: { feedback: ActionFeedback }) {
  if (feedback === null) return null;
  return (
    <div
      className={`rounded-md p-3 text-sm ${
        feedback.kind === "ok"
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {feedback.text}
    </div>
  );
}
