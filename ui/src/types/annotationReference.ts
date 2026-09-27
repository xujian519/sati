/**
 * 标注契约（sidecar v2 + 内容引用变体）。
 *
 * 单一事实源：标注文档（`<文件名>.annot.json`）与随消息发给智能体的引用载荷共用本文件的类型与校验，
 * 避免"写盘形状"与"消息形状"两处各自演化。
 *
 * 坐标恒为**被标注面自身的固有坐标**（SVG 图为 viewBox 像素，栅格图为自然像素，原点在左上角），
 * 与缩放、面板宽度无关——这条不变式让同一条标注在任何视图比例下含义相同。
 *
 * v2 把 v1 的 `figure` 泛化为 `target`：标注不再只服务 SVG 附图（见 {@link AnnotationTargetKind}）。
 * v1 文档在**读取时**迁移，不主动重写磁盘——用户下一次保存才升级。
 */

/** sidecar 文档 schema 版本。 */
export const ANNOTATION_DOCUMENT_VERSION = 2;

/** v1 文档版本（只读兼容；见 {@link normalizeAnnotationDocument}）。 */
const LEGACY_FIGURE_DOCUMENT_VERSION = 1;

/** sidecar 文件后缀（与目标文件同目录同名）。 */
export const ANNOTATION_SIDECAR_SUFFIX = ".annot.json";

/**
 * 被标注面内容哈希的算法。
 *
 * 安全上下文（https / localhost / 127.0.0.1）用 `crypto.subtle` 的 SHA-256；非安全上下文
 * （局域网 http 访问）拿不到 `crypto.subtle`，退化为纯 JS 的非加密指纹 FNV-1a 64——否则
 * 取哈希失败会让整个标注面板不可用。它只用于比较"内容有没有被换过"，不是安全用途。
 */
export type AnnotationHashAlgo = "sha256" | "fnv1a64";

/** 缺省算法：v1 sidecar 未记该字段，一律按 SHA-256 理解。 */
export const DEFAULT_ANNOTATION_HASH_ALGO: AnnotationHashAlgo = "sha256";

const ANNOTATION_HASH_ALGOS: readonly AnnotationHashAlgo[] = ["sha256", "fnv1a64"];

/** 是否是受支持的哈希算法。 */
export function isAnnotationHashAlgo(value: unknown): value is AnnotationHashAlgo {
  return typeof value === "string" && (ANNOTATION_HASH_ALGOS as readonly string[]).includes(value);
}

/** 一条标注的形状。 */
export type AnnotationKind = "arrow" | "rect" | "ellipse" | "pen" | "text";

/** 被标注面固有坐标系里的点。 */
export type AnnotationPoint = readonly [number, number];

/** 被标注面固有坐标系里的矩形：x, y, width, height。 */
export type AnnotationBox = readonly [number, number, number, number];

/**
 * 标注落在被标注面的哪个部件上（只有内联 SVG 图能解析）。
 *
 * 栅格图没有图元层，因此这类标注恒不带锚定——它的定位完全依赖坐标与用户写的说明。
 */
export type AnnotationAnchor = {
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
  /** 该元素在被标注面固有坐标下的包围盒。 */
  bbox: AnnotationBox;
};

/** 用户画的一条标注。 */
export type AnnotationMark = {
  /** 文档内唯一的标注 id。 */
  id: string;
  /** 形状。 */
  kind: AnnotationKind;
  /** 描边色（CSS 十六进制）。 */
  color: string;
  /**
   * 形状几何（被标注面固有坐标）：箭头为尾→头，矩形/椭圆为两个对角，手绘为采样点序列，
   * 文字只有锚点。
   */
  points: readonly AnnotationPoint[];
  /** 用户给这条标注写的说明。 */
  text?: string;
  /**
   * 画这条标注时，被标注面是哪一版（`annotationTargetFingerprint` 的取值，形如 `"sha256:ab…"`）。
   *
   * 基线记在**每条标注**上而不是整篇文档上：同一个文档里可能既有从 sidecar 载入的旧版标注、
   * 又有用户在文件被替换后新画的标注，只有逐条才说得清"这一条对的是哪一版"。缺省 = 未知
   * 基线（v2 之前写下的数据），一律不告警。
   */
  targetFingerprint?: string;
  /** 标注指向的部件（仅内联 SVG 面可解析）。 */
  anchor?: AnnotationAnchor;
};

/**
 * 被标注面的种类。
 *
 * `figure-svg` 与 `image` 的差别不只是介质类型：只有前者能内联成活 DOM，从而解析出标注
 * 落在哪个图元上（见 {@link AnnotationAnchor}）。
 */
export type AnnotationTargetKind = "figure-svg" | "image";

const ANNOTATION_TARGET_KINDS: readonly AnnotationTargetKind[] = ["figure-svg", "image"];

/** 是否是受支持的被标注面种类。 */
export function isAnnotationTargetKind(value: unknown): value is AnnotationTargetKind {
  return typeof value === "string" && (ANNOTATION_TARGET_KINDS as readonly string[]).includes(value);
}

/** 被标注面的几何与身份。 */
export type AnnotatedTargetInfo = {
  /** 面种类。 */
  kind: AnnotationTargetKind;
  /** 文件在 Host 上的绝对路径。 */
  path: string;
  /** 相对项目根的路径（sidecar 落盘与引用都用它）。 */
  relativePath: string;
  /** 文件媒体类型。 */
  mediaType: string;
  /** 面固有宽度（像素）。 */
  width: number;
  /** 面固有高度（像素）。 */
  height: number;
  /** 标注时刻的内容哈希，用于识别"文件已被替换"。 */
  sha256: string;
  /**
   * `sha256` 是用哪种算法算出来的。缺省（v1 sidecar 未记该字段）= `"sha256"`。
   *
   * 记录它是为了让"算法不同"可判定：非安全上下文只能算 FNV-1a，与旧 sidecar 的 SHA-256
   * 不可比，此时**不**判失配（见 `isSavedAnnotationStale`）。
   */
  hashAlgo?: AnnotationHashAlgo;
};

/** 与目标文件同目录的 sidecar 文档。 */
export type AnnotationDocument = {
  version: typeof ANNOTATION_DOCUMENT_VERSION;
  target: AnnotatedTargetInfo;
  /** 首次保存时间（ISO）。 */
  createdAt: string;
  /** 本次保存时间（ISO）。 */
  updatedAt: string;
  /** 按绘制顺序排列的标注。 */
  marks: readonly AnnotationMark[];
  /** 用户自己写的一段总体说明。 */
  summary?: string;
};

/** 一份未落盘的标注（保存前由 UI 组装）。 */
export type AnnotationDraft = {
  target: AnnotatedTargetInfo;
  marks: readonly AnnotationMark[];
  summary?: string;
  createdAt?: string;
};

/** 随消息发给智能体的标注引用载荷。 */
export type AnnotationReferenceData = {
  /** 全文标注文档（与 sidecar 同形，供审计与逐条回应）。 */
  document: AnnotationDocument;
  /** sidecar 绝对路径；未落盘时为 null。 */
  sidecarPath: string | null;
};

/**
 * 目标文件同目录的 sidecar 绝对路径（**带扩展名**）。
 *
 * 同目录下的 `图3.svg` 与 `图3.png` 是两份不同的标注，只按主名派生会让它们落到同一个文件上
 * （v1 的形态，见 {@link legacyAnnotationSidecarPath}）：读回时会拿邻居的标注当自己的（锚点、
 * 坐标都不成立），保存时覆盖邻居的标注。新写入一律走这里。
 */
export function annotationSidecarPath(targetPath: string): string {
  return `${annotationDirectory(targetPath)}${annotationFileName(targetPath)}${ANNOTATION_SIDECAR_SUFFIX}`;
}

/** v1 的 sidecar 路径（只按主名派生）；只用于读回历史文件，不再作为写入位置。 */
export function legacyAnnotationSidecarPath(targetPath: string): string {
  return `${annotationDirectory(targetPath)}${annotationBaseName(targetPath)}${ANNOTATION_SIDECAR_SUFFIX}`;
}

/** 读回顺序：新名优先，再回退 v1 主名名字（无扩展名的文件两者相同，去重）。 */
export function annotationSidecarCandidates(targetPath: string): string[] {
  return [...new Set([annotationSidecarPath(targetPath), legacyAnnotationSidecarPath(targetPath)])];
}

/**
 * 这份 sidecar 文档是不是**这个文件**的标注。
 *
 * 判据就是文件名（含扩展名）：sidecar 与目标同目录，派生只可能在扩展名上撞车。大小写不敏感
 * ——macOS / Windows 上 `图3.SVG` 与 `图3.svg` 是同一个文件。
 */
export function annotationTargetsFile(document: AnnotationDocument, targetPath: string): boolean {
  return annotationFileName(document.target.path).toLowerCase() === annotationFileName(targetPath).toLowerCase();
}

/**
 * 审阅图（被标注面 + 标注，随后作为图片部分发给模型）的文件名。
 *
 * 不落盘——它只作为附件名出现，让智能体在消息里能指代这张图。同样带扩展名：同目录的
 * `图3.svg` 与 `图3.png` 各有各的审阅图，附件同名就分不出是哪一张。
 */
export function annotationImageName(targetPath: string): string {
  return `${annotationFileName(targetPath)}.annotated.png`;
}

/** 含扩展名的文件名。 */
function annotationFileName(targetPath: string): string {
  const slash = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  return slash < 0 ? targetPath : targetPath.slice(slash + 1);
}

/** 去掉扩展名的文件名（v1 派生用）。 */
function annotationBaseName(targetPath: string): string {
  const slash = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  const name = slash < 0 ? targetPath : targetPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** 文件所在目录（含结尾分隔符）。 */
function annotationDirectory(targetPath: string): string {
  const slash = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  return slash < 0 ? "" : targetPath.slice(0, slash + 1);
}

/** 组装一份标注文档（保存与发消息共用同一份装配）。 */
export function buildAnnotationDocument(
  draft: AnnotationDraft,
  now: string = new Date().toISOString(),
): AnnotationDocument {
  const summary = draft.summary?.trim();
  return {
    version: ANNOTATION_DOCUMENT_VERSION,
    target: draft.target,
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
    marks: draft.marks,
    ...(summary ? { summary } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPoint(value: unknown): value is AnnotationPoint {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function isBox(value: unknown): value is AnnotationBox {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber);
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

const MARK_KINDS: readonly AnnotationKind[] = ["arrow", "rect", "ellipse", "pen", "text"];

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return typeof value === "string" && (MARK_KINDS as readonly string[]).includes(value);
}

function readAnchor(value: unknown): AnnotationAnchor | undefined {
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

export function isAnnotationMark(value: unknown): value is AnnotationMark {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isAnnotationKind(value.kind)) return false;
  if (typeof value.color !== "string") return false;
  if (!Array.isArray(value.points) || value.points.length === 0 || !value.points.every(isPoint)) return false;
  if (!isOptionalString(value.text)) return false;
  if (!isOptionalString(value.targetFingerprint)) return false;
  const anchor = value.anchor;
  return anchor === undefined || anchor === null || readAnchor(anchor) !== undefined;
}

function isMarksArray(value: unknown): value is readonly AnnotationMark[] {
  return Array.isArray(value) && value.every(isAnnotationMark);
}

function isTargetInfo(value: unknown): value is AnnotatedTargetInfo {
  if (!isRecord(value)) return false;
  return (
    isAnnotationTargetKind(value.kind) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.relativePath) &&
    isNonEmptyString(value.mediaType) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    isNonEmptyString(value.sha256) &&
    (value.hashAlgo === undefined || isAnnotationHashAlgo(value.hashAlgo))
  );
}

/**
 * 内容指纹（`<algo>:<hex>`）。
 *
 * 把算法与摘要合成一个可比较的字符串：既有 sidecar 缺 `hashAlgo` 时按 SHA-256 补全，
 * 跨算法比较也只会判为"不同"，不会把两种算法的摘要误判成同一版。
 */
export function annotationTargetFingerprint(target: Pick<AnnotatedTargetInfo, "sha256" | "hashAlgo">): string {
  return `${target.hashAlgo ?? DEFAULT_ANNOTATION_HASH_ALGO}:${target.sha256}`;
}

/** 校验一份 from-wire 的 v2 标注文档。 */
export function isAnnotationDocument(value: unknown): value is AnnotationDocument {
  if (!isRecord(value)) return false;
  if (value.version !== ANNOTATION_DOCUMENT_VERSION) return false;
  if (!isTargetInfo(value.target)) return false;
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  if (!isMarksArray(value.marks)) return false;
  return isOptionalString(value.summary) || value.summary === undefined;
}

/**
 * v1 的 `figure` 字段（v2 起改由 `target` 承载）。
 *
 * 单独读而不是复用 {@link isTargetInfo}：v1 没有 `kind`，而这一层存在的意义正是补上它。
 *
 * `relativePath` 在 v1 里**不是必有字段**：姊妹项目插件写下的 sidecar 只记绝对 `path`
 * （外加一个 Sati 不认的 `address`）。这类文件在用户工作区里真实存在，缺它就整体判废会
 * 让既有标注静默消失——所以按 `path` 兜底，与"该字段沿用编辑器给的路径形态"的既有约定一致。
 */
function readLegacyFigure(value: unknown): AnnotatedTargetInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.path)) return undefined;
  const relativePath = isNonEmptyString(value.relativePath) ? value.relativePath : value.path;
  if (!isNonEmptyString(value.mediaType)) return undefined;
  if (!isFiniteNumber(value.width) || value.width <= 0) return undefined;
  if (!isFiniteNumber(value.height) || value.height <= 0) return undefined;
  if (!isNonEmptyString(value.sha256)) return undefined;
  if (value.hashAlgo !== undefined && !isAnnotationHashAlgo(value.hashAlgo)) return undefined;
  return {
    kind: "figure-svg",
    path: value.path,
    relativePath,
    mediaType: value.mediaType,
    width: value.width,
    height: value.height,
    sha256: value.sha256,
    ...(value.hashAlgo === undefined ? {} : { hashAlgo: value.hashAlgo }),
  };
}

/** 把 v1 文档迁移成 v2；结构读不懂时返回 null。 */
function migrateLegacyFigureDocument(candidate: Record<string, unknown>): AnnotationDocument | null {
  const target = readLegacyFigure(candidate.figure);
  if (target === undefined) return null;
  if (!isNonEmptyString(candidate.createdAt) || !isNonEmptyString(candidate.updatedAt)) return null;
  if (!Array.isArray(candidate.marks)) return null;
  const marks: AnnotationMark[] = [];
  for (const raw of candidate.marks) {
    if (!isRecord(raw)) return null;
    const { figureFingerprint, ...rest } = raw;
    if (!isOptionalString(figureFingerprint)) return null;
    const mark: Record<string, unknown> = { ...rest };
    if (figureFingerprint !== undefined) mark.targetFingerprint = figureFingerprint;
    if (!isAnnotationMark(mark)) return null;
    marks.push(mark);
  }
  const summary = candidate.summary;
  if (!isOptionalString(summary)) return null;
  return {
    version: ANNOTATION_DOCUMENT_VERSION,
    target,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    marks,
    ...(summary === undefined || summary === "" ? {} : { summary }),
  };
}

/**
 * 把一份 from-wire 的文档规整成 v2：v2 原样接受，v1 迁移，其余返回 null。
 *
 * 读兼容是硬要求：用户工作区里已经有 v1 的 `<图名>.annot.json`，读不出来就等于标注静默消失。
 */
export function normalizeAnnotationDocument(value: unknown): AnnotationDocument | null {
  if (isAnnotationDocument(value)) return value;
  if (isRecord(value) && value.version === LEGACY_FIGURE_DOCUMENT_VERSION) {
    return migrateLegacyFigureDocument(value);
  }
  return null;
}

/** 这份文档是不是可读的标注文档（v1 或 v2）。 */
export function isReadableAnnotationDocument(value: unknown): boolean {
  return normalizeAnnotationDocument(value) !== null;
}

/**
 * 解析 sidecar 文本。
 *
 * 读不懂的 sidecar 一律按"从未标注过"处理（返回 null），这样用户可以重新标注，
 * 而不是预览直接打不开。
 */
export function parseAnnotationDocument(text: string): AnnotationDocument | null {
  try {
    return normalizeAnnotationDocument(JSON.parse(text));
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
export function annotationSummary(document: AnnotationDocument, marksLabel: (count: number) => string): string {
  const firstNote = document.marks.find(mark => (mark.text ?? "").trim().length > 0)?.text?.trim();
  return firstNote ?? marksLabel(document.marks.length);
}

/** 锚定信息的可读描述（智能体据此定位到 FigureSpec 节点）。 */
export function describeAnchor(anchor: AnnotationAnchor | undefined): string {
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

function describeShape(mark: AnnotationMark): string {
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
 * 这条标注是否画在与文档当前面**不同**的版本上。
 *
 * 缺省基线（v2 之前写下的数据）返回 false——不知道的事不告警。
 */
export function isMarkFromEarlierTarget(mark: AnnotationMark, documentFingerprint: string): boolean {
  return mark.targetFingerprint !== undefined && mark.targetFingerprint !== documentFingerprint;
}

/**
 * 把一条标注渲染成智能体读的一行。
 *
 * 智能体面向的文本固定用英文（与 `[Content references selected by user:]` 提示块同语言），
 * 用户自己的说明与总体说明原样带入，不做翻译。
 *
 * @param documentFingerprint - 文档当前面的指纹；给了才会标出"这一条画在旧版上"。
 */
export function describeAnnotationMark(mark: AnnotationMark, index: number, documentFingerprint?: string): string {
  const marker = MARKER_INDEX[index] ?? `${index + 1}.`;
  const anchor = describeAnchor(mark.anchor);
  const note = (mark.text ?? "").trim();
  const head = [describeShape(mark), anchor === "" ? "" : `(${anchor})`].filter(part => part !== "").join(" ");
  const staleSuffix =
    documentFingerprint !== undefined && isMarkFromEarlierTarget(mark, documentFingerprint)
      ? " [drawn on an earlier version of the annotated file]"
      : "";
  return `${marker} ${head}${note === "" ? " (no note)" : `: ${note}`}${staleSuffix}`;
}

/**
 * 逐条渲染全部标注。
 *
 * @param documentFingerprint - 文档当前面的指纹；给了才会逐条标出"画在旧版上"。
 */
export function describeAnnotationMarks(marks: readonly AnnotationMark[], documentFingerprint?: string): string[] {
  return marks.map((mark, index) => describeAnnotationMark(mark, index, documentFingerprint));
}
