/**
 * HTML 预览容器：查看 | 标注 双模式（H3，入口唯一，见 docs/html-annotation-plan.md §3.5）。
 *
 * - 「查看」= 既有行为：沙箱 iframe 原样渲染（同样受 P0 的 CSP 与凭据约束）。
 * - 「标注」= 固定 1024×768 渲染面 + 桥接快照锚定（`HtmlAnnotator`）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import HtmlAnnotator from "../../../annotation/html/HtmlAnnotator";

const TAB =
  "inline-flex h-6 items-center rounded-md border px-2 text-[12px] leading-none transition-colors " +
  "border-neutral-200 text-neutral-600 hover:bg-neutral-100 disabled:opacity-45 disabled:hover:bg-transparent " +
  "dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

type HtmlDocumentPreviewProps = {
  url: string;
  title: string;
  /** 标注模式所需的项目上下文；缺省时「标注」标签不可用。 */
  projectName?: string;
  filePath?: string;
  fileName?: string;
};

export default function HtmlDocumentPreview({ url, title, projectName, filePath, fileName }: HtmlDocumentPreviewProps) {
  const { t } = useTranslation("codeEditor");
  const [mode, setMode] = useState<"view" | "annotate">("view");
  const annotatable = projectName !== undefined && filePath !== undefined && fileName !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
        <button type="button" className={TAB} aria-pressed={mode === "view"} onClick={() => setMode("view")}>
          {t("annotator.view")}
        </button>
        <button
          type="button"
          className={TAB}
          aria-pressed={mode === "annotate"}
          disabled={!annotatable}
          onClick={() => setMode("annotate")}
        >
          {t("annotator.annotate")}
        </button>
      </div>

      {mode === "annotate" && annotatable ? (
        <HtmlAnnotator
          projectName={projectName}
          filePath={filePath}
          fileName={fileName}
          previewUrl={url}
          title={title}
        />
      ) : (
        <iframe
          className="min-h-0 w-full flex-1 border-0 bg-white"
          src={url}
          title={title}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}
