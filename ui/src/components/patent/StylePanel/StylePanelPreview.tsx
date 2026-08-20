/**
 * 预览 iframe（纯展示）：srcdoc 由上层 useDocumentSource 计算。
 */

import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";

type StylePanelPreviewProps = {
  srcdoc: string;
  loadError: string | null;
  onRetry: () => void;
};

export default function StylePanelPreview({ srcdoc, loadError, onRetry }: StylePanelPreviewProps) {
  const { t } = useTranslation("stylePanel");

  if (loadError !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
          {loadError === "no_project"
            ? t("preview.noProject", { defaultValue: "No project selected." })
            : t("preview.readFailed", { defaultValue: "Failed to read the document file." })}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("preview.retry", { defaultValue: "Retry" })}
        </button>
      </div>
    );
  }

  if (srcdoc === "") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <iframe
      className="h-full w-full border-0 bg-white"
      title={t("preview.title", { defaultValue: "Document typography preview" })}
      sandbox="allow-forms allow-modals allow-popups allow-scripts"
      srcDoc={srcdoc}
    />
  );
}
