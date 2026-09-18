/**
 * PDF 文本选中 → 内容引用的取文逻辑：归一化、上下文窗口、出现位置、页码定位与文本层取文。
 *
 * 原先内联在 `view/subcomponents/PdfDocumentPreview.tsx`（#159 N07 抽出）。除前三个纯函数外，
 * 后三个按 `[data-pdf-page-number]` 约定读 DOM，故与 `.textLayer` 结构同址可测。
 */

/** 选中文本两侧各截取的上下文字符数。 */
export const CONTEXT_RADIUS = 500;

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildSurroundingText(documentText: string, selectedText: string): string {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return "";

  const index = normalizedDocument.indexOf(normalizedSelected);
  if (index < 0) return normalizedSelected;

  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(normalizedDocument.length, index + normalizedSelected.length + CONTEXT_RADIUS);
  return normalizedDocument.slice(start, end).trim();
}

/**
 * 返回选中文本在文档里的出现序号：当前实现只区分"出现过（1）"与"没出现（null）"，
 * **不区分数次出现**（同名文本出现两次也只记 1）。这是既有行为，抽取时未改。
 */
export function getOccurrenceIndex(documentText: string, selectedText: string): number | null {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return null;
  return normalizedDocument.includes(normalizedSelected) ? 1 : null;
}

export function getSelectedPageNumbers(root: HTMLElement, range: Range): number[] {
  const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-pdf-page-number]"));
  return pages
    .filter(page => {
      try {
        return range.intersectsNode(page);
      } catch {
        // intersectsNode can throw on detached/odd nodes — treat the page as not selected.
        return false;
      }
    })
    .map(page => Number.parseInt(page.dataset.pdfPageNumber || "", 10))
    .filter(pageNumber => Number.isFinite(pageNumber) && pageNumber > 0);
}

export function getTextLayerText(root: HTMLElement, pageNumbers: number[]): string {
  const pages =
    pageNumbers.length > 0
      ? pageNumbers
          .map(pageNumber => root.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`))
          .filter((page): page is HTMLElement => Boolean(page))
      : Array.from(root.querySelectorAll<HTMLElement>("[data-pdf-page-number]"));

  return pages
    .map(page => page.querySelector<HTMLElement>(".textLayer")?.textContent || "")
    .filter(Boolean)
    .join("\n");
}

export function getClosestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}
