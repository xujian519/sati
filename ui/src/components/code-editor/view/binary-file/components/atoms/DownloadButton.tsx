import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { useDownloadUrl } from "../../hooks/use-download-url";

export default function DownloadButton({ projectName, file }: { projectName?: string; file: CodeEditorFile }) {
  const { t } = useTranslation("codeEditor");
  const downloadUrl = useDownloadUrl(projectName, file.path);
  if (!downloadUrl) return null;

  return (
    <a
      href={downloadUrl}
      download={file.name}
      className="rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
    >
      {t("actions.download")}
    </a>
  );
}
