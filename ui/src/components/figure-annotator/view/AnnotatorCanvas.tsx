/**
 * 绘制面：把标注画在图面上，并把指针输入变成标注。
 *
 * 每条画完的形状都上交给父组件持有，这里只保留"正在画的那一条"。坐标一律是**图面像素**，
 * 所以同一条标注在任何缩放与面板宽度下含义相同。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { FigureAnnotationMark, FigurePoint } from "../../../types/annotationReference";
import { MIN_DRAG_DISTANCE, PEN_SAMPLE_STEP, type AnnotatorTool } from "../constants/annotator";
import { anchorAtPoint } from "../utils/figure-dom";
import {
  MARK_FONT_STACK,
  MARK_HALO_WIDTH,
  MARK_STROKE_WIDTH,
  MARK_TEXT_FONT_SIZE,
  markPathData,
  markTextBox,
} from "../utils/render";

/** 隐形选中描边的宽度（图面像素）。 */
const HIT_WIDTH = 14;

export type AnnotatorCanvasProps = {
  /** 图面宽度（像素）。 */
  width: number;
  /** 图面高度（像素）。 */
  height: number;
  /** 已提交的标注，按绘制顺序。 */
  marks: readonly FigureAnnotationMark[];
  /** 当前工具。 */
  tool: AnnotatorTool;
  /** 新标注的描边色。 */
  color: string;
  /** 承载内联图的容器（锚定命中以它为坐标原点）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 当前选中的标注。 */
  selectedId: string | null;
  /** 选中一条标注（null 表示取消选中）。 */
  onSelect: (id: string | null) => void;
  /** 提交一条画完的标注。 */
  onAdd: (mark: FigureAnnotationMark) => void;
  /** 删除一条标注（双击）。 */
  onRemove: (id: string) => void;
  /** 由父组件提供的 id 生成器。 */
  nextId: () => string;
};

/** 画标注并收集指针输入。 */
export function AnnotatorCanvas(props: AnnotatorCanvasProps): ReactNode {
  const { width, height, marks, tool, color, containerRef, selectedId } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draft, setDraft] = useState<FigureAnnotationMark | null>(null);
  const drawing = useRef(false);

  /** 指针位置换算成图面像素。 */
  const toFigure = (event: ReactPointerEvent<SVGSVGElement>): FigurePoint => {
    const svg = svgRef.current;
    if (svg === null) return [0, 0];
    const rect = svg.getBoundingClientRect();
    return [(event.clientX - rect.left) * (width / rect.width), (event.clientY - rect.top) * (height / rect.height)];
  };

  /** 描述指针落在哪个图元上。 */
  const anchorFor = (event: ReactPointerEvent<SVGSVGElement>) => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return undefined;
    return anchorAtPoint(container, event.clientX, event.clientY, width / rect.width, height / rect.height);
  };

  const start = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (tool === "select") return;
    event.preventDefault();
    const point = toFigure(event);
    if (tool === "text") {
      const mark: FigureAnnotationMark = { id: props.nextId(), kind: "text", color, points: [point], text: "" };
      props.onAdd(mark);
      props.onSelect(mark.id);
      return;
    }
    drawing.current = true;
    if (typeof event.currentTarget.setPointerCapture === "function" && event.pointerId !== undefined) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // 拖拽类标注一开始就需要两个对角；手绘起始就是它的第一个采样点，不能重复入路径。
    const seed: FigurePoint[] = tool === "pen" ? [point] : [point, point];
    setDraft({ id: props.nextId(), kind: tool, color, points: seed });
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drawing.current || draft === null) return;
    const point = toFigure(event);
    if (draft.kind === "pen") {
      const last = draft.points[draft.points.length - 1];
      if (last !== undefined && Math.hypot(point[0] - last[0], point[1] - last[1]) < PEN_SAMPLE_STEP) return;
      setDraft({ ...draft, points: [...draft.points, point] });
      return;
    }
    setDraft({ ...draft, points: [draft.points[0] as FigurePoint, point] });
  };

  const finish = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drawing.current || draft === null) return;
    drawing.current = false;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.pointerId !== undefined &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraft(null);
    if (draft.points.length < 2) return;
    const first = draft.points[0];
    const last = draft.points[draft.points.length - 1];
    if (first === undefined || last === undefined) return;
    if (draft.kind !== "pen" && Math.hypot(last[0] - first[0], last[1] - first[1]) < MIN_DRAG_DISTANCE) return;
    const anchor = anchorFor(event);
    const mark: FigureAnnotationMark = { ...draft, ...(anchor === undefined ? {} : { anchor }) };
    props.onAdd(mark);
    // 选中刚画的这条：说明框随即落到它身上，不必再点一次。
    props.onSelect(mark.id);
  };

  const renderMark = (mark: FigureAnnotationMark, isDraft: boolean): ReactNode => {
    const path = markPathData(mark);
    const box = markTextBox(mark);
    const selected = selectedId === mark.id;
    const anchorPoint = mark.points[0];
    return (
      <g key={mark.id} opacity={isDraft ? 0.75 : 1}>
        {path === undefined ? null : (
          <>
            <path
              d={path}
              fill="none"
              stroke="#ffffff"
              strokeWidth={MARK_HALO_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={path}
              fill="none"
              stroke={mark.color}
              strokeWidth={MARK_STROKE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {isDraft ? null : (
              <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={HIT_WIDTH}
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onPointerDown={event => {
                  event.stopPropagation();
                  props.onSelect(mark.id);
                }}
                onDoubleClick={event => {
                  event.stopPropagation();
                  props.onRemove(mark.id);
                }}
              />
            )}
            {selected ? <path d={path} fill="none" stroke="#4c8dff" strokeWidth={1} strokeDasharray="4 3" /> : null}
          </>
        )}
        {box === undefined ? (
          // 还没写字的文字标注：画一个虚线占位框，否则用户看不见自己刚点的那一条。
          mark.kind === "text" && anchorPoint !== undefined ? (
            <g>
              <rect
                x={anchorPoint[0] - 3}
                y={anchorPoint[1] - MARK_TEXT_FONT_SIZE}
                width={20}
                height={MARK_TEXT_FONT_SIZE * 1.4}
                fill="#ffffff"
                stroke={mark.color}
                strokeWidth={1}
                strokeDasharray="3 2"
              />
              <text
                x={anchorPoint[0]}
                y={anchorPoint[1]}
                fontFamily={MARK_FONT_STACK}
                fontSize={MARK_TEXT_FONT_SIZE}
                fill={mark.color}
              >
                T
              </text>
              {isDraft ? null : (
                <rect
                  x={anchorPoint[0] - 6}
                  y={anchorPoint[1] - MARK_TEXT_FONT_SIZE - 2}
                  width={26}
                  height={MARK_TEXT_FONT_SIZE + 6}
                  fill="transparent"
                  style={{ pointerEvents: "all", cursor: "pointer" }}
                  onPointerDown={event => {
                    event.stopPropagation();
                    props.onSelect(mark.id);
                  }}
                  onDoubleClick={event => {
                    event.stopPropagation();
                    props.onRemove(mark.id);
                  }}
                />
              )}
              {selected ? (
                <rect
                  x={anchorPoint[0] - 6}
                  y={anchorPoint[1] - MARK_TEXT_FONT_SIZE - 2}
                  width={26}
                  height={MARK_TEXT_FONT_SIZE + 6}
                  fill="none"
                  stroke="#4c8dff"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ) : null}
            </g>
          ) : null
        ) : (
          <>
            <rect
              x={box.x - 4}
              y={box.y - MARK_TEXT_FONT_SIZE}
              width={box.width}
              height={box.height}
              rx={3}
              fill="#ffffff"
              stroke={mark.color}
              strokeWidth={1}
            />
            <text x={box.x} y={box.y} fontFamily={MARK_FONT_STACK} fontSize={MARK_TEXT_FONT_SIZE} fill={mark.color}>
              {box.text}
            </text>
            {isDraft ? null : (
              <rect
                x={box.x - 6}
                y={box.y - MARK_TEXT_FONT_SIZE - 2}
                width={box.width + 4}
                height={box.height + 4}
                fill="transparent"
                style={{ pointerEvents: "all", cursor: "pointer" }}
                onPointerDown={event => {
                  event.stopPropagation();
                  props.onSelect(mark.id);
                }}
                onDoubleClick={event => {
                  event.stopPropagation();
                  props.onRemove(mark.id);
                }}
              />
            )}
            {selected ? (
              <rect
                x={box.x - 6}
                y={box.y - MARK_TEXT_FONT_SIZE - 2}
                width={box.width + 4}
                height={box.height + 4}
                fill="none"
                stroke="#4c8dff"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            ) : null}
          </>
        )}
      </g>
    );
  };

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 touch-none ${tool === "select" ? "cursor-default" : "cursor-crosshair"}`}
      data-figure-annotator-overlay=""
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={() => {
        if (tool === "select") props.onSelect(null);
      }}
    >
      {marks.map(mark => renderMark(mark, false))}
      {draft === null ? null : renderMark(draft, true)}
    </svg>
  );
}
