import { useTranslation } from "react-i18next";
import { getFileTypeBadge } from "../../utils/file-type";

export default function FileTypeBadge({ fileName }: { fileName: string }) {
  const { t } = useTranslation("codeEditor");
  const badge = getFileTypeBadge(fileName);

  return (
    <span
      title={t(badge.titleKey)}
      aria-label={t(badge.titleKey)}
      className={[
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold leading-none shadow-xs ring-1 ring-black/5",
        badge.className,
      ].join(" ")}
    >
      {badge.label}
    </span>
  );
}
