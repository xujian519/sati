/**
 * 把一条标注画成 SVG 图元。
 *
 * 实时覆盖层（React）与导出成审阅图（拼字符串后光栅化）都走这里，因此"用户看到的"与
 * "发给智能体的"不可能漂移。
 */
import type { FigureAnnotationMark, FigurePoint } from "../../../types/annotationReference";

/** 标注描边宽度（图面像素）。 */
export const MARK_STROKE_WIDTH = 2.5;

/** 白色垫底描边宽度：附图是白底黑线，没有白晕的标注会糊在图形上。 */
export const MARK_HALO_WIDTH = MARK_STROKE_WIDTH + 2.5;

/** 文字标注字号（图面像素）。 */
export const MARK_TEXT_FONT_SIZE = 16;

/** 箭头头部长度（图面像素）。 */
const ARROW_HEAD = 14;

/** 箭头头部半角（弧度）。 */
const ARROW_SPREAD = Math.PI / 7;

/**
 * 标注字体栈。**不含引号**：它会被插进 SVG 属性值里，引号会截断属性、让整张审阅图解码失败。
 */
export const MARK_FONT_STACK = "system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif";

/** 两个对角归一化为左上原点加正尺寸。 */
function bounds(first: FigurePoint, second: FigurePoint): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(first[0], second[0]),
    y: Math.min(first[1], second[1]),
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  };
}

/** 坐标取一位小数，压缩路径数据。 */
function n(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

/**
 * 一条标注的描边路径数据。
 *
 * @returns 路径数据；文字标注返回 undefined（它画成文字而非描边）。
 */
export function markPathData(mark: FigureAnnotationMark): string | undefined {
  const [first, second] = mark.points;
  if (first === undefined) return undefined;
  switch (mark.kind) {
    case "arrow": {
      if (second === undefined) return undefined;
      const angle = Math.atan2(second[1] - first[1], second[0] - first[0]);
      const left: FigurePoint = [
        second[0] - ARROW_HEAD * Math.cos(angle - ARROW_SPREAD),
        second[1] - ARROW_HEAD * Math.sin(angle - ARROW_SPREAD),
      ];
      const right: FigurePoint = [
        second[0] - ARROW_HEAD * Math.cos(angle + ARROW_SPREAD),
        second[1] - ARROW_HEAD * Math.sin(angle + ARROW_SPREAD),
      ];
      return (
        `M ${n(first[0])} ${n(first[1])} L ${n(second[0])} ${n(second[1])}` +
        ` M ${n(left[0])} ${n(left[1])} L ${n(second[0])} ${n(second[1])}` +
        ` L ${n(right[0])} ${n(right[1])}`
      );
    }
    case "rect": {
      if (second === undefined) return undefined;
      const box = bounds(first, second);
      return `M ${n(box.x)} ${n(box.y)} H ${n(box.x + box.width)} V ${n(box.y + box.height)} H ${n(box.x)} Z`;
    }
    case "ellipse": {
      if (second === undefined) return undefined;
      const box = bounds(first, second);
      const rx = box.width / 2;
      const ry = box.height / 2;
      const cx = box.x + rx;
      const cy = box.y + ry;
      if (rx === 0 || ry === 0) return `M ${n(box.x)} ${n(box.y)} L ${n(box.x + box.width)} ${n(box.y + box.height)}`;
      return (
        `M ${n(cx - rx)} ${n(cy)} a ${n(rx)} ${n(ry)} 0 1 0 ${n(rx * 2)} 0` +
        ` a ${n(rx)} ${n(ry)} 0 1 0 ${n(-rx * 2)} 0`
      );
    }
    case "pen": {
      const [start, ...rest] = mark.points;
      if (start === undefined) return undefined;
      return [`M ${n(start[0])} ${n(start[1])}`, ...rest.map(point => `L ${n(point[0])} ${n(point[1])}`)].join(" ");
    }
    default:
      return undefined;
  }
}

/** 文字标注画在哪、写什么。 */
export type MarkTextBox = {
  x: number;
  y: number;
  /** 实际画出的文字（用户只写了说明、没写标签时为空）。 */
  text: string;
  width: number;
  height: number;
};

/**
 * 解析文字标注的可读盒。
 *
 * @returns 盒；标注既无标签也无说明时返回 undefined。
 */
export function markTextBox(mark: FigureAnnotationMark): MarkTextBox | undefined {
  const anchor = mark.points[0];
  if (anchor === undefined) return undefined;
  const text = (mark.text ?? "").trim();
  if (text === "") return undefined;
  const longest = text.split("\n").reduce((widest, line) => Math.max(widest, line.length), 0);
  return {
    x: anchor[0],
    y: anchor[1],
    text,
    width: longest * MARK_TEXT_FONT_SIZE * 0.62 + 8,
    height: MARK_TEXT_FONT_SIZE * 1.35,
  };
}
