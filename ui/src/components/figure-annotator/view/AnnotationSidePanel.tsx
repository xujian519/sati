/**
 * 标注器的下半面板：当前标注的说明、这次要改什么的总体说明、以及标注清单。
 *
 * 清单里每一条都能点选（把说明框切到那条上）与删除；标注清单的编号与发给智能体的编号一致。
 */
import type { ReactNode } from "react";
import type { FigureAnnotationMark } from "../../../types/annotationReference";
import type { AnnotatorState } from "../hooks/useAnnotatorState";
import { MARK_FONT_STACK, markPathData, markTextBox } from "../utils/render";

/** 文字域样式。 */
const TEXTAREA =
  "min-h-11 max-h-30 resize-y rounded-md border border-neutral-200 bg-white p-1 text-[12px] " +
  "text-neutral-700 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200";

/** 清单里那条标注的小图。 */
function markGlyph(mark: FigureAnnotationMark): ReactNode {
  const path = markPathData(mark);
  const box = markTextBox(mark);
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" aria-hidden="true">
      {path === undefined ? null : (
        <path
          d={path}
          fill="none"
          stroke={mark.color}
          strokeWidth={3}
          transform={`scale(${mark.kind === "pen" ? 1 : 0.6})`}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {box === undefined && mark.kind === "text" ? (
        <text x={2} y={12} fontSize={11} fill={mark.color} fontFamily={MARK_FONT_STACK}>
          T
        </text>
      ) : null}
    </svg>
  );
}

export type AnnotationSidePanelProps = {
  annotator: AnnotatorState;
  translate: (key: string) => string;
};

/** 说明与标注清单面板。 */
export default function AnnotationSidePanel({ annotator, translate }: AnnotationSidePanelProps): ReactNode {
  const selected = annotator.marks.find(mark => mark.id === annotator.selectedId) ?? null;
  return (
    <>
      <div className="flex shrink-0 items-end gap-1.5 border-t border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[12px]">
            {selected === null ? translate("note") : `${translate("note")} · ${selected.kind}`}
          </span>
          <textarea
            className={TEXTAREA}
            value={selected?.text ?? ""}
            placeholder={translate("notePlaceholder")}
            disabled={selected === null}
            onChange={event => {
              if (selected !== null) annotator.updateMarkText(selected.id, event.target.value);
            }}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[12px]">{translate("summary")}</span>
          <textarea
            className={TEXTAREA}
            value={annotator.summary}
            placeholder={translate("summaryPlaceholder")}
            onChange={event => annotator.setSummary(event.target.value)}
          />
        </label>
      </div>
      <div className="max-h-33 shrink-0 overflow-auto border-t border-neutral-200 px-2 py-1 text-[12px] dark:border-neutral-800">
        <div className="text-[11px] opacity-75">{`${translate("marks")} (${annotator.marks.length})`}</div>
        {annotator.marks.length === 0 ? (
          <div className="py-1 text-neutral-500 dark:text-neutral-400">{translate("noMarks")}</div>
        ) : (
          annotator.marks.map((mark, index) => (
            <div key={mark.id} className="flex items-baseline gap-1.5 py-0.5">
              <span className="min-w-4 text-neutral-400 dark:text-neutral-500">{index + 1}</span>
              {markGlyph(mark)}
              <button
                type="button"
                className="flex-1 cursor-pointer truncate text-left"
                onClick={() => annotator.setSelectedId(mark.id)}
              >
                {(mark.text ?? "").trim() === "" ? translate("emptyText") : mark.text}
                {mark.anchor === undefined
                  ? ""
                  : ` · ${translate("anchor")}: ${mark.anchor.ref ?? mark.anchor.nodeId ?? mark.anchor.title ?? mark.anchor.tag}`}
              </button>
              <button
                type="button"
                className="cursor-pointer text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                onClick={() => annotator.removeMark(mark.id)}
              >
                {translate("delete")}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
