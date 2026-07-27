import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { useTranslation } from 'react-i18next';
import BuiltinOfficeToolbar from './BuiltinOfficeToolbar';

type DocxBuiltinPreviewProps = {
  blob: Blob;
  downloadUrl?: string | null;
  downloadName?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  onError: (error: Error) => void;
};

type OutlineItem = {
  id: string;
  level: number;
  title: string;
  element: HTMLElement;
};

type SearchMatch = {
  range: Range;
  element: HTMLElement;
};

function getHeadingLevel(element: HTMLElement): number | null {
  const tagMatch = /^H([1-6])$/.exec(element.tagName);
  if (tagMatch) return Number(tagMatch[1]);
  const classMatch = String(element.className).match(/heading[\s_-]*([1-6])/i);
  return classMatch ? Number(classMatch[1]) : null;
}

function findOutlineItems(root: HTMLElement): OutlineItem[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p'))
    .map((element, index) => {
      const level = getHeadingLevel(element);
      const title = element.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (!level || !title) return null;
      const id = `pilotdeck-docx-heading-${index}`;
      element.dataset.pilotdeckOutlineId = id;
      return { id, level, title, element };
    })
    .filter((item): item is OutlineItem => item !== null);
}

function findTextMatches(root: HTMLElement, query: string): SearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const matches: SearchMatch[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('style,script')) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const text = node.textContent || '';
    const normalizedText = text.toLocaleLowerCase();
    let start = 0;
    while (start <= normalizedText.length - normalizedQuery.length) {
      const index = normalizedText.indexOf(normalizedQuery, start);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + normalizedQuery.length);
      matches.push({
        range,
        element: node.parentElement || root,
      });
      start = index + Math.max(1, normalizedQuery.length);
    }
    node = walker.nextNode();
  }

  return matches;
}

export default function DocxBuiltinPreview({
  blob,
  downloadUrl,
  downloadName,
  isFullscreen = false,
  onToggleFullscreen,
  refreshing = false,
  onRefresh,
  onError,
}: DocxBuiltinPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pages, setPages] = useState<HTMLElement[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchMatchesRef = useRef<SearchMatch[]>([]);
  const highlightId = useId().replace(/[^a-z0-9_-]/gi, '');
  const allHighlightName = `pilotdeck-docx-search-${highlightId}`;
  const activeHighlightName = `${allHighlightName}-active`;

  useEffect(() => {
    const container = viewerRef.current;
    if (!container) return undefined;
    let cancelled = false;

    container.replaceChildren();
    setRendered(false);
    setOutline([]);
    setPages([]);
    setCurrentPage(1);

    renderAsync(blob, container, container, {
      className: 'pilotdeck-docx',
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderAltChunks: false,
      useBase64URL: true,
    })
      .then(() => {
        if (cancelled) return;
        const nextPages = Array.from(
          container.querySelectorAll<HTMLElement>('section.pilotdeck-docx'),
        );
        setPages(nextPages);
        setOutline(findOutlineItems(container));
        setRendered(true);
      })
      .catch((error) => {
        if (!cancelled) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [blob, onError]);

  useEffect(() => {
    const wrapper = viewerRef.current?.querySelector<HTMLElement>('.pilotdeck-docx-wrapper');
    if (wrapper) wrapper.style.zoom = String(zoom);
  }, [rendered, zoom]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || pages.length === 0) return undefined;
    const updateCurrentPage = () => {
      const top = scroll.getBoundingClientRect().top + 24;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      pages.forEach((page, index) => {
        const distance = Math.abs(page.getBoundingClientRect().top - top);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      setCurrentPage(closestIndex + 1);
    };
    updateCurrentPage();
    scroll.addEventListener('scroll', updateCurrentPage, { passive: true });
    return () => scroll.removeEventListener('scroll', updateCurrentPage);
  }, [pages]);

  useEffect(() => {
    const root = viewerRef.current;
    const cssHighlights = (globalThis.CSS as unknown as {
      highlights?: Map<string, unknown>;
    })?.highlights;
    const HighlightConstructor = (globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    cssHighlights?.delete(allHighlightName);
    cssHighlights?.delete(activeHighlightName);
    searchMatchesRef.current = [];

    if (!root || !searchQuery.trim()) {
      setSearchMatchIndex(0);
      return;
    }

    const matches = findTextMatches(root, searchQuery);
    searchMatchesRef.current = matches;
    setSearchMatchIndex((current) => (
      matches.length > 0 ? Math.min(current, matches.length - 1) : 0
    ));
    if (cssHighlights && HighlightConstructor && matches.length > 0) {
      cssHighlights.set(
        allHighlightName,
        new HighlightConstructor(...matches.map((match) => match.range)),
      );
    }

    return () => {
      cssHighlights?.delete(allHighlightName);
      cssHighlights?.delete(activeHighlightName);
    };
  }, [activeHighlightName, allHighlightName, rendered, searchQuery]);

  useEffect(() => {
    const matches = searchMatchesRef.current;
    const cssHighlights = (globalThis.CSS as unknown as {
      highlights?: Map<string, unknown>;
    })?.highlights;
    const HighlightConstructor = (globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    cssHighlights?.delete(activeHighlightName);
    if (matches.length === 0) return;
    const match = matches[Math.min(searchMatchIndex, matches.length - 1)];
    if (cssHighlights && HighlightConstructor) {
      cssHighlights.set(activeHighlightName, new HighlightConstructor(match.range));
    }
    match.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeHighlightName, searchMatchIndex, searchQuery]);

  const goToPage = useCallback((pageNumber: number) => {
    const page = pages[Math.max(0, Math.min(pages.length - 1, pageNumber - 1))];
    page?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [pages]);

  const moveSearch = useCallback((direction: -1 | 1) => {
    const count = searchMatchesRef.current.length;
    if (count === 0) return;
    setSearchMatchIndex((current) => (current + direction + count) % count);
  }, []);

  const outlinePanel = useMemo(() => (
    <aside className="w-64 shrink-0 overflow-auto border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {t('pdfToolbar.outline')}
      </div>
      <div className="space-y-0.5">
        {outline.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            className="block min-h-8 w-full rounded-md py-1.5 pr-2 text-left text-[12px] leading-5 text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
            onClick={() => item.element.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          >
            <span className="line-clamp-2">{item.title}</span>
          </button>
        ))}
      </div>
    </aside>
  ), [outline, t]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <style>{`
        ::highlight(${allHighlightName}) {
          background: rgba(250, 204, 21, 0.62);
          color: inherit;
        }
        ::highlight(${activeHighlightName}) {
          background: rgba(249, 115, 22, 0.88);
          color: #111827;
        }
        .pilotdeck-docx-wrapper {
          background: rgb(245 245 245) !important;
          padding: 28px !important;
        }
        .dark .pilotdeck-docx-wrapper {
          background: rgb(23 23 23) !important;
        }
        .pilotdeck-docx-wrapper > section.pilotdeck-docx {
          margin: 0 auto 24px !important;
          box-shadow: 0 1px 4px rgb(0 0 0 / 0.16) !important;
        }
      `}</style>
      <BuiltinOfficeToolbar
        navigationAvailable={outline.length > 0}
        navigationVisible={navigationVisible && outline.length > 0}
        onToggleNavigation={() => setNavigationVisible((value) => !value)}
        zoom={zoom}
        onZoomChange={setZoom}
        currentItem={currentPage}
        itemCount={pages.length}
        onPreviousItem={() => goToPage(currentPage - 1)}
        onNextItem={() => goToPage(currentPage + 1)}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchMatchIndex={searchMatchIndex}
        searchMatchCount={searchMatchesRef.current.length}
        onPreviousMatch={() => moveSearch(-1)}
        onNextMatch={() => moveSearch(1)}
        refreshing={refreshing}
        onRefresh={onRefresh}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        downloadUrl={downloadUrl}
        downloadName={downloadName}
      />
      <div className="flex min-h-0 flex-1">
        {navigationVisible && outline.length > 0 ? outlinePanel : null}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div ref={viewerRef} data-testid="docx-builtin-preview" className="min-h-full" />
        </div>
      </div>
    </div>
  );
}
