import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PdfOutlineItem } from "../../../utils/pdfOutline";
import { renderToolbarIcon } from "./pdf-toolbar-icon";

export type PdfOutlineTreeProps = {
  items: PdfOutlineItem[];
  currentPage: number;
  onSelect: (pageNumber: number) => void;
  expandLabel: string;
  collapseLabel: string;
  nested?: boolean;
};

export default function PdfOutlineTree({
  items,
  currentPage,
  onSelect,
  expandLabel,
  collapseLabel,
  nested = false,
}: PdfOutlineTreeProps) {
  return (
    <ul role={nested ? "group" : "tree"} className="space-y-0.5">
      {items.map(item => (
        <PdfOutlineTreeItem
          key={item.id}
          item={item}
          currentPage={currentPage}
          onSelect={onSelect}
          expandLabel={expandLabel}
          collapseLabel={collapseLabel}
        />
      ))}
    </ul>
  );
}

export function PdfOutlineTreeItem({
  item,
  currentPage,
  onSelect,
  expandLabel,
  collapseLabel,
}: {
  item: PdfOutlineItem;
  currentPage: number;
  onSelect: (pageNumber: number) => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const hasChildren = item.items.length > 0;
  const [expanded, setExpanded] = useState(true);
  const active = item.pageNumber === currentPage;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-current={active ? "page" : undefined}>
      <div
        className={[
          "group flex min-h-8 items-start rounded-md text-[12px] transition-colors",
          active
            ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-200"
            : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900",
        ].join(" ")}
      >
        {hasChildren ? (
          <button
            type="button"
            title={expanded ? collapseLabel : expandLabel}
            aria-label={expanded ? collapseLabel : expandLabel}
            onClick={() => setExpanded(value => !value)}
            className="flex h-8 w-7 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            {renderToolbarIcon(expanded ? ChevronDown : ChevronRight)}
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          disabled={item.pageNumber === null}
          title={item.title}
          onClick={() => {
            if (item.pageNumber !== null) onSelect(item.pageNumber);
          }}
          className="min-w-0 flex-1 py-1.5 pr-2 text-left leading-5 disabled:cursor-default"
        >
          <span className="line-clamp-2">{item.title}</span>
        </button>
      </div>
      {hasChildren && expanded ? (
        <div className="ml-3 border-l border-neutral-200 pl-1 dark:border-neutral-800">
          <PdfOutlineTree
            items={item.items}
            currentPage={currentPage}
            onSelect={onSelect}
            expandLabel={expandLabel}
            collapseLabel={collapseLabel}
            nested
          />
        </div>
      ) : null}
    </li>
  );
}
