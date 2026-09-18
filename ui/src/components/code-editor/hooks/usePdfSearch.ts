import { useCallback, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy } from "../view/subcomponents/pdfjs";
import { findPdfSearchMatches, resolveSearchStatus, type PdfSearchMatch } from "../utils/pdfSearch";
import { normalizeText } from "../utils/pdfTextSelection";

type UsePdfSearchOptions = {
  pdfDocument: PDFDocumentProxy | null;
  /** 每页的文本（由 `PdfPage` 在文本层渲染后回填），命中搜索时无需再取一次。 */
  pageTextRef: RefObject<Map<number, string>>;
  /** 每页的文本片段，供 `findPdfSearchMatches` 映射命中位置。 */
  pageTextItemsRef: RefObject<Map<number, string[]>>;
  jumpToPage: (pageNumber: number) => void;
  /** 把某页加入强制渲染集合——命中页可能还没渲染，也就还没有文本层。 */
  forceRenderPage: (pageNumber: number) => void;
};

export type PdfSearchController = {
  isOpen: boolean;
  query: string;
  results: PdfSearchMatch[];
  resultIndex: number;
  /** 工具条上的状态文案（空串表示还没搜过）。 */
  status: string;
  open: () => void;
  close: () => void;
  updateQuery: (value: string) => void;
  run: () => Promise<void>;
  goTo: (index: number, results?: PdfSearchMatch[]) => void;
  /** 换文件时复位（由加载 effect 调用）。 */
  reset: () => void;
};

/**
 * PDF 全文搜索的状态机：开关/查询词/结果/当前命中，以及文内检索本身。
 *
 * 从 `view/subcomponents/PdfDocumentPreview.tsx` 抽出（#159 N07）。抽出时的口径：
 * **函数体逐字搬迁**，只把两处内联的"强制渲染某页"改为调用传入的 `forceRenderPage`
 * （其实现与原来那两行一致），并把查询词变更时的失效逻辑收进 `updateQuery`。
 */
export function usePdfSearch({
  pdfDocument,
  pageTextRef,
  pageTextItemsRef,
  jumpToPage,
  forceRenderPage,
}: UsePdfSearchOptions): PdfSearchController {
  const { t } = useTranslation("codeEditor");
  const searchRequestIdRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PdfSearchMatch[]>([]);
  const [searchResultIndex, setSearchResultIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searchCompleted, setSearchCompleted] = useState(false);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    searchRequestIdRef.current += 1;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchResultIndex(-1);
    setSearching(false);
    setSearchCompleted(false);
  }, []);

  const updateSearchQuery = useCallback((value: string) => {
    // Changing the query invalidates any in-flight search immediately.
    // Otherwise a slow search for the previous query can repopulate
    // stale results before the user submits the new value.
    searchRequestIdRef.current += 1;
    setSearchQuery(value);
    setSearchResults([]);
    setSearchResultIndex(-1);
    setSearching(false);
    setSearchCompleted(false);
  }, []);

  const resetSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchResultIndex(-1);
    setSearching(false);
    setSearchCompleted(false);
    searchRequestIdRef.current += 1;
  }, []);

  const goToSearchResult = useCallback(
    (index: number, results = searchResults) => {
      if (results.length === 0) {
        setSearchResultIndex(-1);
        return;
      }
      const nextIndex = (index + results.length) % results.length;
      const pageNumber = results[nextIndex].pageNumber;
      forceRenderPage(pageNumber);
      setSearchResultIndex(nextIndex);
      jumpToPage(pageNumber);
    },
    [forceRenderPage, jumpToPage, searchResults],
  );

  const runSearch = useCallback(async () => {
    const document = pdfDocument;
    const query = normalizeText(searchQuery);
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setSearchCompleted(false);

    if (!document || !query) {
      setSearchResults([]);
      setSearchResultIndex(-1);
      setSearching(false);
      return;
    }

    setSearching(true);
    const nextResults: PdfSearchMatch[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (searchRequestIdRef.current !== requestId) return;
        let textItems = pageTextItemsRef.current.get(pageNumber);
        if (textItems === undefined) {
          const page = await document.getPage(pageNumber);
          const textContent = await page.getTextContent();
          textItems = textContent.items.map(item => ("str" in item ? item.str : "")).filter(Boolean);
          pageTextItemsRef.current.set(pageNumber, textItems);
          pageTextRef.current.set(pageNumber, textItems.join(" "));
        }
        nextResults.push(...findPdfSearchMatches(textItems, query, pageNumber));
      }
    } catch {
      // A failed page-text fetch drops partial results; the finally block still finalizes the search state.
      nextResults.length = 0;
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setSearching(false);
        setSearchCompleted(true);
        setSearchResults(nextResults);
        if (nextResults.length > 0) {
          goToSearchResult(0, nextResults);
        } else {
          setSearchResultIndex(-1);
        }
      }
    }
  }, [goToSearchResult, pageTextItemsRef, pageTextRef, pdfDocument, searchQuery]);

  return {
    isOpen: searchOpen,
    query: searchQuery,
    results: searchResults,
    resultIndex: searchResultIndex,
    status: resolveSearchStatus(t, searching, searchCompleted, searchResults, searchResultIndex),
    open: openSearch,
    close: closeSearch,
    updateQuery: updateSearchQuery,
    run: runSearch,
    goTo: goToSearchResult,
    reset: resetSearch,
  };
}
