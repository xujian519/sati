import { useTranslation } from "react-i18next";

/**
 * 预览失败时的重试入口。
 *
 * 与 DownloadButton 同层的 atom：失败态此前只有「下载」与「去设置」两个出口，
 * 用户想再试一次只能切走再切回来（重试会清掉 runtimeError 并重新拉取）。
 */
export default function RetryPreviewButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("codeEditor");
  return (
    <button
      type="button"
      onClick={onRetry}
      className="rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
    >
      {t("officePreview.retry")}
    </button>
  );
}
