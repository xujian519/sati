import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export default function FallbackContent({
  title,
  message,
  onClose,
  actions,
}: {
  title: string;
  message: string;
  onClose: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation("codeEditor");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-white p-8 dark:bg-neutral-950">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
          <svg
            className="h-7 w-7 text-neutral-500 dark:text-neutral-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <div>
          <h3 className="mb-1 text-[14px] font-medium text-neutral-900 dark:text-neutral-100">{title}</h3>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">{message}</p>
        </div>
        <div className="mt-2 flex items-center justify-center gap-2">
          {actions}
          <button
            onClick={onClose}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-[13px] text-white transition-colors hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {t("actions.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
