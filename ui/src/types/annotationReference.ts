/**
 * 附图标注契约（sidecar v1 + 内容引用变体）。
 *
 * 单一事实源：标注文档（`<图名>.annot.json`）与随消息发给智能体的引用载荷共用本文件的类型与校验，
 * 避免"写盘形状"与"消息形状"两处各自演化。
 *
 * 坐标恒为**图面像素**（原点在图左上角，一格 = 固有尺寸下的一像素），与缩放、面板宽度无关——
 * 这条不变式让同一条标注在任何视图比例下含义相同。
 */

/** sidecar 文档 schema 版本。 */
export const FIGURE_ANNOTATION_VERSION = 1;

/** sidecar 文件后缀（与图同目录同名）。 */
export const FIGURE_ANNOTATION_SUFFIX = ".annot.json";

/** 一条标注的形状。 */
export type FigureAnnotationKind = "arrow" | "rect" | "ellipse" | "pen" | "text";

/** 图面像素坐标点。 */
export type FigurePoint = readonly [number, number];

/** 图面像素矩形：x, y, width, height。 */
export type FigureBox = readonly [number, number, number, number];

/** 标注落在哪个图元上（仅内联 SVG 图可解析）。 */
export type FigureAnnotationAnchor = {
  /** 命中元素名（小写）。 */
  tag: string;
  /** 元素 `id`（内置渲染器为 `n-<nodeId>`）。 */
  id?: string;
  /** 从 `n-<nodeId>` 还原的 FigureSpec 节点 id——智能体据此改生成源。 */
  nodeId?: string;
  /** 元素 `data-ref`（附图标记号）。 */
  ref?: string;
  /** 元素 `<title>` 文本（Graphviz 把节点名写在这里）。 */
  title?: string;
  /** 元素自身文字（截断）。 */
  text?: string;
  /** 该元素在图面像素下的包围盒。 */
  bbox: FigureBox;
};

/** 用户画的一条标注。 */
export type FigureAnnotationMark = {
  /** 文档内唯一的标注 id。 */
  id: string;
  /** 形状。 */
  kind: FigureAnnotationKind;
  /** 描边色（CSS 十六进制）。 */
  color: string;
  /**
   * 形状几何（图面像素）：箭头为尾→头，矩形/椭圆为两个对角，手绘为采样点序列，
   * 文字只有锚点。
   */
  points: readonly FigurePoint[];
  /** 用户给这条标注写的说明。 */
  text?: string;
  /** 标注指向的图元。 */
  anchor?: FigureAnnotationAnchor;
};

/** 被标注图面的几何与身份。 */
export type AnnotatedFigureInfo = {
  /** 图在 Host 上的绝对路径。 */
  path: string;
  /** 相对项目根的路径（sidecar 落盘与引用都用它）。 */
  relativePath: string;
  /** 图文件媒体类型。 */
  mediaType: string;
  /** 图面固有宽度（像素）。 */
  width: number;
  /** 图面固有高度（像素）。 */
  height: number;
  /** 标注时刻的图内容哈希，用于识别"图已被重画"。 */
  sha256: string;
};

/** 与图同目录的 sidecar 文档。 */
export type FigureAnnotationDocument = {
  version: typeof FIGURE_ANNOTATION_VERSION;
  figure: AnnotatedFigureInfo;
  /** 首次保存时间（ISO）。 */
  createdAt: string;
  /** 本次保存时间（ISO）。 */
  updatedAt: string;
  /** 按绘制顺序排列的标注。 */
  marks: readonly FigureAnnotationMark[];
  /** 用户自己写的一段总体说明。 */
  summary?: string;
};

/** 一份未落盘的标注（保存前由 UI 组装）。 */
export type FigureAnnotationDraft = {
  figure: AnnotatedFigureInfo;
  marks: readonly FigureAnnotationMark[];
  summary?: string;
  createdAt?: string;
};

/** 随消息发给智能体的标注引用载荷。 */
export type FigureAnnotationReferenceData = {
  /** 全文标注文档（与 sidecar 同形，供审计与逐条回应）。 */
  document: FigureAnnotationDocument;
  /** sidecar 绝对路径；未落盘时为 null。 */
  sidecarPath: string | null;
};

/** 图同目录的 sidecar 绝对路径。 */
export function figureAnnotationSidecarPath(figurePath: string): string {
  return `${figureAnnotationDirectory(figurePath)}${figureAnnotationBaseName(figurePath)}${FIGURE_ANNOTATION_SUFFIX}`;
}

/**
 * 审阅图（原图 + 标注，随后作为图片部分发给模型）的文件名。
 *
 * 不落盘——它只作为附件名出现，让智能体在消息里能指代这张图。
 */
export function figureAnnotationImageName(figurePath: string): string {
  return `${figureAnnotationBaseName(figurePath)}.annotated.png`;
}

/** 去掉扩展名的文件名。 */
function figureAnnotationBaseName(figurePath: string): string {
  const slash = Math.max(figurePath.lastIndexOf("/"), figurePath.lastIndexOf("\\"));
  const name = slash < 0 ? figurePath : figurePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** 文件所在目录（含结尾分隔符）。 */
function figureAnnotationDirectory(figurePath: string): string {
  const slash = Math.max(figurePath.lastIndexOf("/"), figurePath.lastIndexOf("\\"));
  return slash < 0 ? "" : figurePath.slice(0, slash + 1);
}

/** 组装一份标注文档（保存与发消息共用同一份装配）。 */
export function buildFigureAnnotationDocument(
  draft: FigureAnnotationDraft,
  now: string = new Date().toISOString(),
): FigureAnnotationDocument {
  const summary = draft.summary?.trim();
  return {
    version: FIGURE_ANNOTATION_VERSION,
    figure: draft.figure,
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
    marks: draft.marks,
    ...(summary ? { summary } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPoint(value: unknown): value is FigurePoint {
  return Array.isArray(value) && value.length === 2 && value.every(entry => isFiniteNumber(entry));
}

function isBox(value: unknown): value is FigureBox {
  return Array.isArray(value) && value.length === 4 && value.every(entry => isFiniteNumber(entry));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

const MARK_KINDS: readonly FigureAnnotationKind[] = ["arrow", "rect", "ellipse", "pen", "text"];

export function isFigureAnnotationKind(value: unknown): value is FigureAnnotationKind {
  return typeof value === "string" && (MARK_KINDS as readonly string[]).includes(value);
}

function readAnchor(value: unknown): FigureAnnotationAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.tag) || !isBox(value.bbox)) return undefined;
  if (!isOptionalString(value.id)) return undefined;
  if (!isOptionalString(value.nodeId)) return undefined;
  if (!isOptionalString(value.ref)) return undefined;
  if (!isOptionalString(value.title)) return undefined;
  if (!isOptionalString(value.text)) return undefined;
  return {
    tag: value.tag,
    bbox: value.bbox,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

export function isFigureAnnotationMark(value: unknown): value is FigureAnnotationMark {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isFigureAnnotationKind(value.kind)) return false;
  if (typeof value.color !== "string") return false;
  if (!Array.isArray(value.points) || value.points.length === 0 || !value.points.every(isPoint)) return false;
  if (!isOptionalString(value.text)) return false;
  const anchor = value.anchor;
  return anchor === undefined || anchor === null || readAnchor(anchor) !== undefined;
}

function isMarksArray(value: unknown): value is readonly FigureAnnotationMark[] {
  return Array.isArray(value) && value.every(isFigureAnnotationMark);
}

function isFigureInfo(value: unknown): value is AnnotatedFigureInfo {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.relativePath) &&
    isNonEmptyString(value.mediaType) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    isNonEmptyString(value.sha256)
  );
}

/** 校验一份 from-wire 的标注文档。 */
export function isFigureAnnotationDocument(value: unknown): value is FigureAnnotationDocument {
  if (!isRecord(value)) return false;
  if (value.version !== FIGURE_ANNOTATION_VERSION) return false;
  if (!isFigureInfo(value.figure)) return false;
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  if (!isMarksArray(value.marks)) return false;
  return isOptionalString(value.summary) || value.summary === undefined;
}

/**
 * 解析 sidecar 文本。
 *
 * 读不懂的 sidecar 一律按"从未标注过"处理（返回 null），这样用户可以重新标注，
 * 而不是预览直接打不开。
 */
export function parseFigureAnnotationDocument(text: string): FigureAnnotationDocument | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isFigureAnnotationDocument(parsed) ? parsed : null;
  } catch {
    // 半篇/损坏的 JSON：按"从未标注过"处理，用户可重新标注（见上方函数注释）。
    return null;
  }
}

/**
 * 标注引用的 UI 摘要（引用芯片上显示的那一句）。
 *
 * @param marksLabel - 没有备注时用的条数文案；用户可见文案一律由调用方按 i18n 提供，这里不写死。
 * @returns 摘要文本。
 */
export function figureAnnotationSummary(
  document: FigureAnnotationDocument,
  marksLabel: (count: number) => string,
): string {
  const firstNote = document.marks.find(mark => (mark.text ?? "").trim().length > 0)?.text?.trim();
  return firstNote ?? marksLabel(document.marks.length);
}

/** 锚定信息的可读描述（智能体据此定位到 FigureSpec 节点）。 */
export function describeAnchor(anchor: FigureAnnotationAnchor | undefined): string {
  if (anchor === undefined) return "";
  const parts: string[] = [];
  if (anchor.nodeId !== undefined && anchor.nodeId !== "") parts.push(`node=${anchor.nodeId}`);
  if (anchor.ref !== undefined && anchor.ref !== "") parts.push(`ref=${anchor.ref}`);
  if (anchor.title !== undefined && anchor.title !== "") parts.push(`title="${anchor.title}"`);
  if (anchor.id !== undefined && anchor.id !== "" && anchor.nodeId === undefined) parts.push(`id=${anchor.id}`);
  if (parts.length === 0 && anchor.text !== undefined && anchor.text !== "") parts.push(`text="${anchor.text}"`);
  if (parts.length === 0) parts.push(`<${anchor.tag}>`);
  return parts.join(", ");
}

function round(value: number): number {
  return Math.round(value);
}

function describeShape(mark: FigureAnnotationMark): string {
  const [first, second] = mark.points;
  switch (mark.kind) {
    case "arrow":
      return first !== undefined && second !== undefined
        ? `arrow (${round(first[0])},${round(first[1])}) -> (${round(second[0])},${round(second[1])})`
        : "arrow";
    case "rect":
      return first !== undefined && second !== undefined
        ? `rectangle (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`
        : "rectangle";
    case "ellipse":
      return first !== undefined && second !== undefined
        ? `ellipse (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`
        : "ellipse";
    case "pen":
      return `freehand stroke (${mark.points.length} points)`;
    case "text":
      return first !== undefined ? `text at (${round(first[0])},${round(first[1])})` : "text";
  }
}

const MARKER_INDEX = ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10."] as const;

/**
 * 把一条标注渲染成智能体读的一行。
 *
 * 智能体面向的文本固定用英文（与 `[Content references selected by user:]` 提示块同语言），
 * 用户自己的说明与总体说明原样带入，不做翻译。
 */
export function describeFigureMark(mark: FigureAnnotationMark, index: number): string {
  const marker = MARKER_INDEX[index] ?? `${index + 1}.`;
  const anchor = describeAnchor(mark.anchor);
  const note = (mark.text ?? "").trim();
  const head = [describeShape(mark), anchor === "" ? "" : `(${anchor})`].filter(part => part !== "").join(" ");
  return `${marker} ${head}${note === "" ? " (no note)" : `: ${note}`}`;
}

/** 逐条渲染全部标注。 */
export function describeFigureMarks(marks: readonly FigureAnnotationMark[]): string[] {
  return marks.map((mark, index) => describeFigureMark(mark, index));
}
