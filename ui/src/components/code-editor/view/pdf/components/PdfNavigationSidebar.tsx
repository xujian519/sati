import type { Dispatch, RefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Files, ListTree } from "lucide-react";
import type { PdfNavigationMode } from "../../../utils/documentPreview";
import type { PdfOutlineItem } from "../../../utils/pdfOutline";
import type { PageSize, Rotation } from "../../../utils/pdfViewport";
import * as pdfjs from "../../subcomponents/pdfjs";
import type { NavigationView } from "../pdf-types";
import PdfOutlineTree from "./PdfOutlineTree";
import PdfThumbnail from "./PdfThumbnail";
import { renderToolbarIcon } from "./pdf-toolbar-icon";

type PdfNavigationSidebarProps = {
  navigationMode: PdfNavigationMode;
  navigationLabel: string;
  hasOutline: boolean;
  navigationView: NavigationView;
  setNavigationView: Dispatch<SetStateAction<NavigationView>>;
  outlineItems: PdfOutlineItem[];
  currentPage: number;
  jumpToPage: (pageNumber: number) => void;
  totalPages: number;
  readyDocument: { pdfDocument: pdfjs.PDFDocumentProxy; firstPageSize: PageSize } | null;
  rotation: Rotation;
  filePath: string;
  navigationRef: RefObject<HTMLDivElement | null>;
};

/**
 * PDF 左侧导航栏（缩略图 / 大纲切换）。开关与是否显示仍由调用方用原来那句条件表达式控制，
 * 因此这里的 JSX 与抽出前逐 token 一致（#159 N07）。
 */
export default function PdfNavigationSidebar({
  navigationMode,
  navigationLabel,
  hasOutline,
  navigationView,
  setNavigationView,
  outlineItems,
  currentPage,
  jumpToPage,
  totalPages,
  readyDocument,
  rotation,
  filePath,
  navigationRef,
}: PdfNavigationSidebarProps) {
  const { t } = useTranslation("codeEditor");
  return (
    <aside
      className={[
        "flex shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950",
        hasOutline ? "w-64" : "w-40",
      ].join(" ")}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-2 text-[11px] font-medium text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
        {hasOutline ? (
          <div className="flex items-center rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-900">
            <button
              type="button"
              aria-pressed={navigationView === "thumbnails"}
              title={t("pdfToolbar.pages")}
              onClick={() => setNavigationView("thumbnails")}
              className={[
                "flex h-7 items-center gap-1.5 rounded px-2 transition-colors",
                navigationView === "thumbnails"
                  ? "bg-white text-neutral-950 shadow-xs dark:bg-neutral-800 dark:text-neutral-50"
                  : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100",
              ].join(" ")}
            >
              {renderToolbarIcon(Files)}
              <span>{t("pdfToolbar.pages")}</span>
            </button>
            <button
              type="button"
              aria-pressed={navigationView === "outline"}
              title={t("pdfToolbar.outline")}
              onClick={() => setNavigationView("outline")}
              className={[
                "flex h-7 items-center gap-1.5 rounded px-2 transition-colors",
                navigationView === "outline"
                  ? "bg-white text-neutral-950 shadow-xs dark:bg-neutral-800 dark:text-neutral-50"
                  : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100",
              ].join(" ")}
            >
              {renderToolbarIcon(ListTree)}
              <span>{t("pdfToolbar.outline")}</span>
            </button>
          </div>
        ) : (
          <span>{navigationLabel}</span>
        )}
        <span className="text-neutral-400 tabular-nums dark:text-neutral-500">{totalPages || "-"}</span>
      </div>
      <div
        ref={navigationRef}
        role="navigation"
        aria-label={navigationView === "outline" ? t("pdfToolbar.outline") : navigationLabel}
        className={[
          "scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2",
          navigationView === "thumbnails" ? "space-y-2" : "",
        ].join(" ")}
      >
        {readyDocument && navigationView === "outline" && hasOutline ? (
          <PdfOutlineTree
            items={outlineItems}
            currentPage={currentPage}
            onSelect={jumpToPage}
            expandLabel={t("pdfToolbar.expandOutline")}
            collapseLabel={t("pdfToolbar.collapseOutline")}
          />
        ) : null}
        {readyDocument && navigationView === "thumbnails"
          ? Array.from({ length: readyDocument.pdfDocument.numPages }, (_, index) => {
              const pageNumber = index + 1;
              const thumbnailLabel =
                navigationMode === "slides"
                  ? t("pdfToolbar.slideLabel", { number: pageNumber })
                  : t("pdfToolbar.pageLabel", { number: pageNumber });
              return (
                <PdfThumbnail
                  key={`${filePath}-thumbnail-${pageNumber}`}
                  pdfDocument={readyDocument.pdfDocument}
                  pageNumber={pageNumber}
                  rotation={rotation}
                  active={currentPage === pageNumber}
                  navigationRootRef={navigationRef}
                  label={thumbnailLabel}
                  onSelect={jumpToPage}
                />
              );
            })
          : null}
      </div>
    </aside>
  );
}
