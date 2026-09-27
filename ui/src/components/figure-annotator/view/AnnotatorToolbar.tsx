/**
 * 标注器的工具条：模式切换、绘制工具、颜色、撤销重做、缩放与两个保存出口。
 */
import type { ReactNode } from "react";
import { ANNOTATOR_COLORS, ANNOTATOR_TOOLS, isDrawingTool, type AnnotatorTool } from "../constants/annotator";
import type { AnnotatorState } from "../hooks/useAnnotatorState";

/** 工具条上一个工具按钮。 */
const TOOL_LABEL_KEYS: Record<AnnotatorTool, string> = {
  select: "toolSelect",
  arrow: "toolArrow",
  rect: "toolRect",
  ellipse: "toolEllipse",
  pen: "toolPen",
  text: "toolText",
};

/** 工具条按钮的统一样式。 */
const BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[12px] leading-none transition-colors " +
  "border-neutral-200 text-neutral-600 hover:bg-neutral-100 disabled:opacity-45 disabled:hover:bg-transparent " +
  "dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

export type AnnotatorToolbarProps = {
  annotator: AnnotatorState;
  /** 当前缩放（数字为倍率，"fit" 为适应宽度）。 */
  zoom: number | "fit";
  /** 生效的缩放倍率（"fit" 时由容器宽度算出）。 */
  scale: number;
  /** 正在保存/提交时禁用两个保存出口。 */
  busy: "saving" | "sending" | null;
  onSubmit: (deliver: boolean) => void;
  onZoomChange: (zoom: number | "fit") => void;
  translate: (key: string) => string;
};

/** 标注器工具条。 */
export default function AnnotatorToolbar({
  annotator,
  zoom,
  scale,
  busy,
  onSubmit,
  onZoomChange,
  translate,
}: AnnotatorToolbarProps): ReactNode {
  const drawing = annotator.mode === "annotate";
  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
      <button type="button" className={BUTTON} aria-pressed={!drawing} onClick={() => annotator.setMode("view")}>
        {translate("view")}
      </button>
      <button type="button" className={BUTTON} aria-pressed={drawing} onClick={() => annotator.setMode("annotate")}>
        {translate("annotate")}
      </button>
      <span className="flex-1" />
      {drawing ? (
        <>
          {ANNOTATOR_TOOLS.filter(isDrawingTool).map(tool => (
            <button
              key={tool}
              type="button"
              className={BUTTON}
              aria-pressed={annotator.tool === tool}
              onClick={() => annotator.setTool(tool)}
            >
              {translate(TOOL_LABEL_KEYS[tool])}
            </button>
          ))}
          {ANNOTATOR_COLORS.map(value => (
            <button
              key={value}
              type="button"
              className={`h-4 w-4 rounded-full border border-black/35 ${
                annotator.color === value ? "outline-2 outline-offset-1 outline-brand-500" : ""
              }`}
              style={{ background: value }}
              aria-label={value}
              aria-pressed={annotator.color === value}
              onClick={() => annotator.setColor(value)}
            />
          ))}
          <button type="button" className={BUTTON} disabled={!annotator.canUndo} onClick={annotator.undo}>
            {translate("undo")}
          </button>
          <button type="button" className={BUTTON} disabled={!annotator.canRedo} onClick={annotator.redo}>
            {translate("redo")}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={annotator.marks.length === 0}
            onClick={annotator.clearMarks}
          >
            {translate("clear")}
          </button>
        </>
      ) : null}
      <span className="flex-1" />
      <button type="button" className={BUTTON} aria-pressed={zoom === "fit"} onClick={() => onZoomChange("fit")}>
        {translate("fitWidth")}
      </button>
      <button type="button" className={BUTTON} aria-pressed={zoom === 1} onClick={() => onZoomChange(1)}>
        {translate("actual")}
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => onZoomChange(Math.max(0.1, (zoom === "fit" ? scale : zoom) / 1.25))}
      >
        −
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => onZoomChange(Math.min(6, (zoom === "fit" ? scale : zoom) * 1.25))}
      >
        +
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={annotator.marks.length === 0 || busy !== null}
        onClick={() => onSubmit(false)}
      >
        {translate("save")}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={annotator.marks.length === 0 || busy !== null}
        onClick={() => onSubmit(true)}
      >
        {translate("saveAndSend")}
      </button>
    </div>
  );
}
