import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { DocumentSelectionSource } from "../../../../../types/documentSelection";
import type { ContentReferenceSelectionMode, ReferenceCapabilities } from "../../../../../types/contentReference";
import type { PdfNavigationMode } from "../../../utils/documentPreview";
import { MAX_SCALE, MIN_SCALE, clamp, parsePageInput, parsePercentInput } from "../../../utils/pdfViewport";
import type { Rotation, ZoomMode } from "../../../utils/pdfViewport";
import type { PdfSearchMatch } from "../../../utils/pdfSearch";
import * as pdfjs from "../../subcomponents/pdfjs";

type UsePdfToolbarControllerOptions = {
  /** 工具条渲染所需的派生值（主组件算好后传入，控制器不再重复推导）。 */
  stats: {
    isLoaded: boolean;
    activeScale: number;
    canZoomIn: boolean;
    canZoomOut: boolean;
    zoomPercent: number;
    currentPage: number;
  };
  /** 文档与跳页。 */
  document: {
    pdfDocument: pdfjs.PDFDocumentProxy | null;
    jumpToPage: (pageNumber: number) => void;
    source: DocumentSelectionSource;
    showPageControls: boolean;
  };
  /** 导航栏开关与缩放模式。 */
  view: {
    navigationMode: PdfNavigationMode;
    navigationOpen: boolean;
    setNavigationOpen: Dispatch<SetStateAction<boolean>>;
    zoomMode: ZoomMode;
    setZoomMode: Dispatch<SetStateAction<ZoomMode>>;
  };
  /** 缩放输入框。 */
  zoom: {
    zoomInput: string;
    setZoomInput: Dispatch<SetStateAction<string>>;
    setZoomInputFocused: Dispatch<SetStateAction<boolean>>;
    setCustomScale: Dispatch<SetStateAction<number>>;
  };
  /** 页码输入框与旋转。 */
  page: {
    rotation: Rotation;
    setRotation: Dispatch<SetStateAction<Rotation>>;
    pageInput: string;
    setPageInput: Dispatch<SetStateAction<string>>;
    setPageInputFocused: Dispatch<SetStateAction<boolean>>;
  };
  /** 搜索状态机（`usePdfSearch` 的投影）。 */
  search: {
    searchOpen: boolean;
    closeSearch: () => void;
    openSearch: () => void;
    searchQuery: string;
    updateSearchQuery: (value: string) => void;
    runSearch: () => Promise<void>;
  };
  searchState: {
    searchStatus: string;
    searchResults: PdfSearchMatch[];
    searchResultIndex: number;
    goToSearchResult: (index: number, results?: PdfSearchMatch[]) => void;
  };
  /** 内容引用菜单状态。 */
  reference: {
    referenceCapabilities: ReferenceCapabilities;
    referenceMode: ContentReferenceSelectionMode | null;
    handleReferenceMode: (mode: ContentReferenceSelectionMode) => void;
    setReferenceMode: Dispatch<SetStateAction<ContentReferenceSelectionMode | null>>;
  };
  /** 工具条文案与元素 id（主组件按 `inputId` 推导）。 */
  labels: {
    currentLocationLabel: string;
    goToLocationLabel: string;
    locationOfLabel: string;
    zoomInputId: string;
    pageInputId: string;
    searchInputId: string;
  };
  /** 头部动作（刷新/全屏/下载）。 */
  actions: {
    onRefresh: (() => void) | null;
    refreshDisabled: boolean;
    onToggleFullscreen: (() => void) | null;
    isFullscreen: boolean;
    downloadUrl: string | null;
    downloadName?: string;
  };
};

/**
 * PDF 工具条控制器：把主组件里散落的工具条输入收成一个对象，交给 `PdfToolbar` 渲染。
 *
 * 从 `view/subcomponents/PdfDocumentPreview.tsx` 抽出（#159 N07）。缩放/页码输入提交
 * 三个回调原本就在主组件里，随本次搬迁落到这里；其余字段是"传引用"（`{ ...group }`），
 * 保证 `PdfToolbar` 的 JSX 与抽出前逐 token 一致。
 */
export function usePdfToolbarController(options: UsePdfToolbarControllerOptions) {
  const { t } = useTranslation("codeEditor");
  const { currentPage, zoomPercent } = options.stats;
  const { pdfDocument, jumpToPage } = options.document;
  const { setZoomMode } = options.view;
  const { zoomInput, setCustomScale, setZoomInput } = options.zoom;
  const { pageInput, setPageInput } = options.page;

  const commitPageInput = useCallback(() => {
    const totalPages = pdfDocument?.numPages || 1;
    const parsed = parsePageInput(pageInput, totalPages);
    if (!parsed) {
      setPageInput(String(currentPage));
      return;
    }
    setPageInput(String(parsed));
    jumpToPage(parsed);
  }, [currentPage, jumpToPage, pageInput, pdfDocument?.numPages, setPageInput]);

  const commitZoomInput = useCallback(() => {
    const parsed = parsePercentInput(zoomInput);
    if (!parsed) {
      setZoomInput(`${zoomPercent}%`);
      return;
    }
    setCustomScale(parsed);
    setZoomMode("custom");
    setZoomInput(`${Math.round(parsed * 100)}%`);
  }, [zoomInput, zoomPercent, setCustomScale, setZoomInput, setZoomMode]);

  const setCustomZoomFromScale = useCallback(
    (nextScale: number) => {
      const next = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      setCustomScale(next);
      setZoomMode("custom");
      setZoomInput(`${Math.round(next * 100)}%`);
    },
    [setCustomScale, setZoomInput, setZoomMode],
  );

  return {
    ...options.stats,
    ...options.document,
    ...options.view,
    ...options.zoom,
    ...options.page,
    ...options.search,
    ...options.searchState,
    ...options.reference,
    ...options.labels,
    ...options.actions,
    t,
    commitPageInput,
    commitZoomInput,
    setCustomZoomFromScale,
  };
}

export type PdfToolbarController = ReturnType<typeof usePdfToolbarController>;
