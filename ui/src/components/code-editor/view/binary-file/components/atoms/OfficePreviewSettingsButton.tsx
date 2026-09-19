import { useTranslation } from "react-i18next";

export default function OfficePreviewSettingsButton() {
  const { t } = useTranslation("codeEditor");
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined") {
          const openSettings = (window as Window & { openSettings?: (tab?: string) => void }).openSettings;
          openSettings?.("config:officePreview");
        }
      }}
      className="rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
    >
      {t("officePreview.configureService")}
    </button>
  );
}
