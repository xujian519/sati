import {
  createDocumentSelectionReference,
  isDocumentSelectionReference,
  type DocumentSelectionReference,
} from "./documentSelection";
import {
  annotationSummary,
  annotationTargetFingerprint,
  describeAnnotationMarks,
  isMarkFromEarlierTarget,
  isReadableAnnotationDocument,
  normalizeAnnotationDocument,
  type AnnotationReferenceData,
} from "./annotationReference";

export const CONTENT_REFERENCE_ATTACHMENT_KIND = "content-reference";
export const CONTENT_REFERENCE_PROMPT_MARKER = "[Content references selected by user:]";

/**
 * 把一条引用加进 composer 的窗口事件名。
 *
 * 预览面板（PDF 选区、表格选区、图片区域、以及附图标注）都靠它把引用交给 composer，
 * composer 侧的唯一监听在 `useChatComposerState`。
 */
export const ADD_CONTENT_REFERENCE_EVENT = "sati:add-chat-reference";

/**
 * 用户可**发起**的选区模式（由各预览器的 capabilities 决定，见 `ReferenceCapabilities`）。
 *
 * 与 {@link ContentReferenceKind} 分开：附图标注也是一种引用，但它不是"选出来的选区"，
 * 没有对应的选择适配器与能力位，把它塞进这个联合会污染选区菜单与能力表。
 */
export type ContentReferenceSelectionMode = "text" | "cells" | "region";

/** 引用载荷的判别式（含标注这类非选区引用）。 */
export type ContentReferenceKind = ContentReferenceSelectionMode | "annotation";

export type ContentReferenceSurface = "document" | "page" | "slide" | "sheet" | "editor" | "figure" | "image" | "html";
export type ContentReferenceRendererId = "pdf" | "office-pdf" | "docx" | "xlsx" | "pptx" | "text" | "html" | "image";
export type ContentReferenceLocatorQuality = "semantic" | "approximate" | "visual";

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ContentReferenceSource = {
  projectName?: string;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  revision?: {
    /**
     * Renderer/cache revision when an exact content digest is unavailable.
     * It is opaque and only intended for stale-reference comparison.
     */
    id?: string;
    size?: number;
    mtimeMs?: number;
    sha256?: string;
  };
};

export type ContentReferenceRenderer = {
  id: ContentReferenceRendererId;
  backend: "builtin" | "libreoffice";
  locatorQuality: ContentReferenceLocatorQuality;
};

export type ContentReferenceBase = {
  schemaVersion: 1;
  kind: typeof CONTENT_REFERENCE_ATTACHMENT_KIND;
  id: string;
  selectionMode: ContentReferenceKind;
  source: ContentReferenceSource;
  renderer: ContentReferenceRenderer;
  createdAt: string;
};

export type TextContentReference = ContentReferenceBase & {
  selectionMode: "text";
  locator: {
    surface: Extract<ContentReferenceSurface, "document" | "page" | "slide" | "editor">;
    pageNumbers?: number[];
    slideNumbers?: number[];
    headingPath?: string[];
    quote: {
      exact: string;
      prefix?: string;
      suffix?: string;
    };
    occurrenceIndex?: number | null;
    rects?: NormalizedRect[];
  };
  selectedText: string;
  surroundingText?: string;
  truncated?: boolean;
};

export type CellRangeSnapshot = {
  range: string;
  displayValues: string[][];
  rawValues?: unknown[][];
  formulas?: string[][];
  rowCount?: number;
  columnCount?: number;
  truncated?: boolean;
};

export type CellRangeContentReference = ContentReferenceBase & {
  selectionMode: "cells";
  locator: {
    surface: "sheet";
    sheetId: string;
    sheetName: string;
    ranges: string[];
    activeRange: string;
  };
  cells: CellRangeSnapshot[];
  headers?: string[][];
  surroundingValues?: string[][];
};

export type ImageRegionContentReference = ContentReferenceBase & {
  selectionMode: "region";
  locator: {
    surface: ContentReferenceSurface;
    pageNumber?: number;
    slideNumber?: number;
    sheetId?: string;
    sheetName?: string;
    rect: NormalizedRect;
    anchorRange?: string;
  };
  image: {
    name: string;
    mimeType: "image/png";
    width: number;
    height: number;
    sha256?: string;
    /**
     * Composer-only payload. It is deliberately removed from the structured
     * message attachment and sent as a normal multimodal image part instead.
     */
    dataUrl?: string;
  };
  nearbyText?: string;
};

/**
 * 标注引用：用户在图片预览里圈画（箭头/框选/圈选/手绘/文字）后提交的那一次标注。
 *
 * 两种面共用这一个判别式：`figure`（SVG 附图，标注可锚定到具体图元）与 `image`（栅格图，
 * 没有图元层，定位只能靠坐标与用户写的说明）。与 region 引用的差别：region 是"一张图里的
 * 一个矩形"，这里是"整幅图 + 逐条标注"，每条标注带自己的说明。标注图（原图 + 标注）作为
 * 普通多模态图片部分随消息发出，`dataUrl` 只是 composer 侧载荷，结构化附件里会剥掉。
 */
export type AnnotationContentReference = ContentReferenceBase & {
  selectionMode: "annotation";
  locator: {
    surface: Extract<ContentReferenceSurface, "figure" | "image" | "html">;
    /** 图面固有宽度（像素）：标注坐标以此参照系为准。 */
    width: number;
    height: number;
  };
  image: {
    name: string;
    mimeType: "image/png";
    width: number;
    height: number;
    sha256?: string;
    /** 仅 composer 用的载荷，见上。 */
    dataUrl?: string;
  };
  annotation: AnnotationReferenceData;
};

export type ContentReference =
  | TextContentReference
  | CellRangeContentReference
  | ImageRegionContentReference
  | AnnotationContentReference;

export type ContentReferenceReasonCode =
  | "NO_TEXT_LAYER"
  | "NO_CELL_MODEL"
  | "SURFACE_NOT_READY"
  | "CAPTURE_UNAVAILABLE"
  | "UNSUPPORTED_RENDERER";

export type CapabilityState = "loading" | "available" | "unavailable";

export type ContentReferenceCapability = {
  state: CapabilityState;
  reason?: ContentReferenceReasonCode;
};

export type ReferenceCapabilities = {
  text: ContentReferenceCapability;
  cells: ContentReferenceCapability;
  region: ContentReferenceCapability;
  recommendedMode: ContentReferenceSelectionMode;
};

export type ContentReferenceSelectionDraft = {
  mode: ContentReferenceSelectionMode;
  valid: boolean;
  summary?: string;
};

export interface ContentReferenceAdapter {
  getCapabilities(): ReferenceCapabilities;
  subscribeCapabilities(listener: (capabilities: ReferenceCapabilities) => void): () => void;
  beginSelection(mode: ContentReferenceSelectionMode): void;
  cancelSelection(): void;
  subscribeSelectionDraft(listener: (draft: ContentReferenceSelectionDraft | null) => void): () => void;
  commitSelection(): Promise<ContentReference | null>;
  focusReference(reference: ContentReference): void;
  dispose(): void;
}

type CreateContentReferenceInput<T extends ContentReference> = Omit<
  T,
  "schemaVersion" | "kind" | "id" | "createdAt"
> & {
  id?: string;
  createdAt?: string;
};

function createReferenceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `content-ref-${crypto.randomUUID()}`;
  }
  return `content-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampNormalized(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  const x = clampNormalized(rect.x);
  const y = clampNormalized(rect.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(1 - x, clampNormalized(rect.width))),
    height: Math.max(0, Math.min(1 - y, clampNormalized(rect.height))),
  };
}

function createContentReference<T extends ContentReference>(input: CreateContentReferenceInput<T>): T {
  return {
    ...input,
    schemaVersion: 1,
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    id: input.id || createReferenceId(),
    createdAt: input.createdAt || new Date().toISOString(),
  } as T;
}

export function createTextContentReference(
  input: CreateContentReferenceInput<TextContentReference>,
): TextContentReference {
  return createContentReference<TextContentReference>({
    ...input,
    locator: {
      ...input.locator,
      ...(input.locator.rects ? { rects: input.locator.rects.map(normalizeRect) } : {}),
    },
  });
}

export function createCellRangeContentReference(
  input: CreateContentReferenceInput<CellRangeContentReference>,
): CellRangeContentReference {
  return createContentReference<CellRangeContentReference>(input);
}

export function createImageRegionContentReference(
  input: CreateContentReferenceInput<ImageRegionContentReference>,
): ImageRegionContentReference {
  return createContentReference<ImageRegionContentReference>({
    ...input,
    locator: {
      ...input.locator,
      rect: normalizeRect(input.locator.rect),
    },
  });
}

export function createAnnotationContentReference(
  input: CreateContentReferenceInput<AnnotationContentReference>,
): AnnotationContentReference {
  return createContentReference<AnnotationContentReference>(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isMatrix(value: unknown, isCell: (cell: unknown) => boolean = () => true): value is unknown[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row) && row.every(isCell));
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || isFiniteNumber(value);
}

function isNormalizedRect(value: unknown): value is NormalizedRect {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
  );
}

function hasValidCommonFields(candidate: Record<string, unknown>) {
  const source = candidate.source;
  const renderer = candidate.renderer;
  if (!isRecord(source) || !isRecord(renderer)) return false;

  const revision = source.revision;
  if (
    revision !== undefined &&
    (!isRecord(revision) ||
      !isOptionalString(revision.id) ||
      !isOptionalString(revision.sha256) ||
      !isOptionalFiniteNumber(revision.size) ||
      !isOptionalFiniteNumber(revision.mtimeMs))
  ) {
    return false;
  }

  return (
    candidate.kind === CONTENT_REFERENCE_ATTACHMENT_KIND &&
    candidate.schemaVersion === 1 &&
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.createdAt) &&
    isNonEmptyString(source.relativePath) &&
    isNonEmptyString(source.fileName) &&
    isOptionalString(source.projectName) &&
    isOptionalString(source.mimeType) &&
    ["pdf", "office-pdf", "docx", "xlsx", "pptx", "text", "html", "image"].includes(String(renderer.id)) &&
    ["builtin", "libreoffice"].includes(String(renderer.backend)) &&
    ["semantic", "approximate", "visual"].includes(String(renderer.locatorQuality))
  );
}

function isTextContentReference(candidate: Record<string, unknown>) {
  if (!isRecord(candidate.locator) || typeof candidate.selectedText !== "string") return false;
  const locator = candidate.locator;
  const quote = locator.quote;
  return (
    ["document", "page", "slide", "editor"].includes(String(locator.surface)) &&
    isRecord(quote) &&
    typeof quote.exact === "string" &&
    isOptionalString(quote.prefix) &&
    isOptionalString(quote.suffix) &&
    (locator.pageNumbers === undefined || isNumberArray(locator.pageNumbers)) &&
    (locator.slideNumbers === undefined || isNumberArray(locator.slideNumbers)) &&
    (locator.headingPath === undefined || isStringArray(locator.headingPath)) &&
    (locator.occurrenceIndex === undefined ||
      locator.occurrenceIndex === null ||
      isFiniteNumber(locator.occurrenceIndex)) &&
    (locator.rects === undefined || (Array.isArray(locator.rects) && locator.rects.every(isNormalizedRect))) &&
    isOptionalString(candidate.surroundingText) &&
    (candidate.truncated === undefined || typeof candidate.truncated === "boolean")
  );
}

function isCellRangeContentReference(candidate: Record<string, unknown>) {
  if (!isRecord(candidate.locator) || !Array.isArray(candidate.cells)) return false;
  const locator = candidate.locator;
  const cellsValid = candidate.cells.every(snapshot => {
    if (!isRecord(snapshot)) return false;
    return (
      isNonEmptyString(snapshot.range) &&
      isMatrix(snapshot.displayValues, cell => typeof cell === "string") &&
      (snapshot.rawValues === undefined || isMatrix(snapshot.rawValues)) &&
      (snapshot.formulas === undefined || isMatrix(snapshot.formulas, cell => typeof cell === "string")) &&
      isOptionalFiniteNumber(snapshot.rowCount) &&
      isOptionalFiniteNumber(snapshot.columnCount) &&
      (snapshot.truncated === undefined || typeof snapshot.truncated === "boolean")
    );
  });

  return (
    locator.surface === "sheet" &&
    isNonEmptyString(locator.sheetId) &&
    isNonEmptyString(locator.sheetName) &&
    isStringArray(locator.ranges) &&
    locator.ranges.length > 0 &&
    isNonEmptyString(locator.activeRange) &&
    candidate.cells.length > 0 &&
    cellsValid &&
    (candidate.headers === undefined || isMatrix(candidate.headers, cell => typeof cell === "string")) &&
    (candidate.surroundingValues === undefined ||
      isMatrix(candidate.surroundingValues, cell => typeof cell === "string"))
  );
}

function isImageRegionContentReference(candidate: Record<string, unknown>) {
  if (!isRecord(candidate.locator) || !isRecord(candidate.image)) return false;
  const locator = candidate.locator;
  const image = candidate.image;
  return (
    // `figure` 与 `image` 与其余面并列：图片预览也提供"框选一块发给智能体"，它的落点既可能是
    // 附录的 SVG 附图（`figure`），也可能是栅格图本身（`image`），都不是页/幻灯片/工作表。
    ["document", "page", "slide", "sheet", "editor", "figure", "image"].includes(String(locator.surface)) &&
    isNormalizedRect(locator.rect) &&
    isOptionalFiniteNumber(locator.pageNumber) &&
    isOptionalFiniteNumber(locator.slideNumber) &&
    isOptionalString(locator.sheetId) &&
    isOptionalString(locator.sheetName) &&
    isOptionalString(locator.anchorRange) &&
    isNonEmptyString(image.name) &&
    image.mimeType === "image/png" &&
    isFiniteNumber(image.width) &&
    image.width > 0 &&
    isFiniteNumber(image.height) &&
    image.height > 0 &&
    isOptionalString(image.sha256) &&
    isOptionalString(image.dataUrl) &&
    isOptionalString(candidate.nearbyText)
  );
}

function isAnnotationContentReference(candidate: Record<string, unknown>) {
  if (!isRecord(candidate.locator) || !isRecord(candidate.image) || !isRecord(candidate.annotation)) return false;
  const locator = candidate.locator;
  const image = candidate.image;
  const annotation = candidate.annotation;
  return (
    ["figure", "image", "html"].includes(String(locator.surface)) &&
    isFiniteNumber(locator.width) &&
    locator.width > 0 &&
    isFiniteNumber(locator.height) &&
    locator.height > 0 &&
    isNonEmptyString(image.name) &&
    image.mimeType === "image/png" &&
    isFiniteNumber(image.width) &&
    image.width > 0 &&
    isFiniteNumber(image.height) &&
    image.height > 0 &&
    isOptionalString(image.sha256) &&
    isOptionalString(image.dataUrl) &&
    (annotation.sidecarPath === null || isNonEmptyString(annotation.sidecarPath)) &&
    // v1 文档也是可读的：历史消息里的引用要在反解时仍能通过校验（归一化时再迁到 v2）。
    isReadableAnnotationDocument(annotation.document)
  );
}

export function isContentReference(value: unknown): value is ContentReference {
  if (!isRecord(value) || !hasValidCommonFields(value)) return false;
  if (value.selectionMode === "text") return isTextContentReference(value);
  if (value.selectionMode === "cells") return isCellRangeContentReference(value);
  if (value.selectionMode === "region") return isImageRegionContentReference(value);
  if (value.selectionMode === "annotation") return isAnnotationContentReference(value);
  return false;
}

export function documentSelectionToContentReference(reference: DocumentSelectionReference): TextContentReference {
  return createTextContentReference({
    id: reference.id,
    createdAt: reference.createdAt,
    selectionMode: "text",
    source: {
      projectName: reference.projectName,
      relativePath: reference.filePath,
      fileName: reference.fileName,
    },
    renderer: {
      id: reference.source,
      backend: reference.source === "office-pdf" ? "libreoffice" : "builtin",
      locatorQuality: reference.source === "office-pdf" ? "approximate" : "semantic",
    },
    locator: {
      surface: "page",
      pageNumbers: reference.pageNumbers,
      quote: { exact: reference.selectedText },
      occurrenceIndex: reference.occurrenceIndex,
    },
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    truncated: reference.truncated,
  });
}

/**
 * 把标注引用里内嵌的文档升到 v2。
 *
 * {@link isContentReference} 为了兼容历史消息接受 v1 文档，但 v1 与 v2 的形状不同
 * （`figure` vs `target`），下游读的是 v2 字段——不在这里升一次，历史消息里的标注会以
 * "文档缺 target"的形态崩在渲染层。升不动（结构损坏）时按引用无效处理。
 */
function upgradeAnnotationDocument(reference: ContentReference): ContentReference | null {
  if (reference.selectionMode !== "annotation") return reference;
  const document = normalizeAnnotationDocument(reference.annotation.document);
  if (document === null) return null;
  return { ...reference, annotation: { ...reference.annotation, document } };
}

export function normalizeContentReference(value: unknown): ContentReference | null {
  if (isContentReference(value)) return upgradeAnnotationDocument(value);
  if (isDocumentSelectionReference(value)) return documentSelectionToContentReference(value);
  return null;
}

export function contentReferenceToLegacyDocumentSelection(reference: TextContentReference): DocumentSelectionReference {
  return createDocumentSelectionReference({
    id: reference.id,
    createdAt: reference.createdAt,
    projectName: reference.source.projectName,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    source: reference.renderer.id === "pdf" ? "pdf" : "office-pdf",
    pageNumbers: reference.locator.pageNumbers || [],
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    occurrenceIndex: reference.locator.occurrenceIndex,
    truncated: reference.truncated,
  });
}

function compactMatrix<T>(values: T[][] | undefined, maxRows = 30, maxColumns = 20) {
  if (!values) return undefined;
  return values.slice(0, maxRows).map(row => row.slice(0, maxColumns));
}

/**
 * 结构化序列化：剥掉 composer 侧才需要的内联图字节。
 *
 * 两个用途都要求剥掉：写进消息附件的 JSON（历史回放要能反解出引用）、以及写进提示块的
 * `Reference JSON:` 行——把 base64 图片正文灌进提示文本会把上下文烧穿。
 */
export function serializableReference(reference: ContentReference): ContentReference {
  if (reference.selectionMode !== "region" && reference.selectionMode !== "annotation") return reference;
  return {
    ...reference,
    image: {
      ...reference.image,
      dataUrl: undefined,
    },
  };
}

export function formatContentReferencePromptBlock(references: ContentReference[]): string {
  const valid = references
    .map(normalizeContentReference)
    .filter((reference): reference is ContentReference => Boolean(reference));
  if (valid.length === 0) return "";

  // 附图标注引用的 `source.relativePath` 就是那张**导出的** .svg：通用行对它是错的，
  // 与标注纪律（"改生成源、不改导出图"）直接冲突，所以含附图标注时把例外写进通用行。
  // 图片标注则是"对文件本身的审阅意见"，没有生成源，另行陈述（逐条纪律仍以每个引用自己的
  // Discipline 行为准）。
  const hasSvgAnnotation = valid.some(
    reference => reference.selectionMode === "annotation" && reference.locator.surface === "figure",
  );
  const hasAnnotation = valid.some(reference => reference.selectionMode === "annotation");
  const lines = [
    CONTENT_REFERENCE_PROMPT_MARKER,
    hasSvgAnnotation
      ? "These are immutable snapshots explicitly selected by the user. Use the source path as the default edit target when the request asks to modify the referenced content; figure annotations are the exception - their source path is the exported figure, and their edit target is stated per reference."
      : hasAnnotation
        ? "These are immutable snapshots explicitly selected by the user. Use the source path as the default edit target when the request asks to modify the referenced content; image annotations are review comments on the annotated file itself, and their discipline is stated per reference."
        : "These are immutable snapshots explicitly selected by the user. Use the source path as the default edit target when the request asks to modify the referenced content.",
  ];
  valid.forEach((reference, index) => {
    lines.push(`${index + 1}. ${reference.selectionMode.toUpperCase()} reference`);
    lines.push(
      reference.selectionMode === "annotation"
        ? reference.locator.surface === "figure"
          ? `   Exported figure: ${reference.source.relativePath} (do not edit; regenerate from its generating source)`
          : `   Annotated file: ${reference.source.relativePath} (read-only review target; it has no generating source to edit)`
        : `   Source: ${reference.source.relativePath}`,
    );
    lines.push(
      `   Renderer: ${reference.renderer.id}/${reference.renderer.backend}; locator=${reference.renderer.locatorQuality}`,
    );
    if (reference.selectionMode === "text") {
      lines.push(`   Location: ${JSON.stringify(reference.locator)}`);
      lines.push(`   Selected text: ${JSON.stringify(reference.selectedText)}`);
      if (reference.surroundingText) {
        lines.push(`   Context: ${JSON.stringify(reference.surroundingText)}`);
      }
    } else if (reference.selectionMode === "cells") {
      lines.push(`   Sheet: ${reference.locator.sheetName}; ranges=${reference.locator.ranges.join(", ")}`);
      lines.push(
        `   Cells: ${JSON.stringify(
          reference.cells.map(snapshot => ({
            range: snapshot.range,
            displayValues: compactMatrix(snapshot.displayValues),
            rawValues: compactMatrix(snapshot.rawValues),
            formulas: compactMatrix(snapshot.formulas),
            rowCount: snapshot.rowCount,
            columnCount: snapshot.columnCount,
            truncated: snapshot.truncated,
          })),
        )}`,
      );
      if (reference.headers?.length) {
        lines.push(`   Nearby header rows: ${JSON.stringify(compactMatrix(reference.headers, 4, 30))}`);
      }
      if (reference.surroundingValues?.length) {
        lines.push(`   Nearby cells: ${JSON.stringify(compactMatrix(reference.surroundingValues, 20, 30))}`);
      }
    } else if (reference.selectionMode === "annotation") {
      const { document, sidecarPath } = reference.annotation;
      // 面词决定坐标参照系与纪律：附图有生成源可改，栅格图没有，措辞不能混用。
      const isFigure = document.target.kind === "figure-svg";
      const surfaceWord = isFigure ? "figure" : "image";
      lines.push(
        `   Annotated ${surfaceWord}: ${document.target.path} (${document.target.width}x${document.target.height})`,
      );
      lines.push(`   Annotation file: ${sidecarPath ?? "(not saved)"}`);
      lines.push(`   Multimodal image attachment: ${reference.image.name}`);
      lines.push(
        `   The image is the ${surfaceWord} with every mark drawn on it; each mark is listed below in draw order.`,
      );
      // 逐条基线比对：文件被换过后载入的标注，其坐标可能已经不对应当前文件，必须让模型知道。
      const targetFingerprint = annotationTargetFingerprint(document.target);
      const earlierCount = document.marks.filter(mark => isMarkFromEarlierTarget(mark, targetFingerprint)).length;
      if (earlierCount > 0) {
        lines.push(
          `   Warning: ${earlierCount} of these marks were drawn on an earlier version of the file, so their coordinates may no longer match it. Verify each one against the attached image.`,
        );
      }
      lines.push(`   Marks (coordinates are ${surfaceWord} pixels, origin at its top-left corner):`);
      for (const line of describeAnnotationMarks(document.marks, targetFingerprint)) lines.push(`   ${line}`);
      if (document.summary) lines.push(`   Overall note: ${document.summary}`);
      lines.push(
        "   Discipline: answer mark by mark, numbered as above, and do not silently skip a mark you cannot honour.",
      );
      if (isFigure) {
        lines.push(
          "   Change the figure's generating source (the FigureSpec or the drawing script/SVG source), never the exported image file;",
        );
        lines.push(
          "   leave unmarked areas untouched, and after regenerating re-check every mark because its coordinates may have shifted.",
        );
      } else {
        // 栅格图没有生成源：沿用附图的"改生成源"纪律会诱使模型回报"已修改该图"，而位图根本没变。
        lines.push(
          "   This image has no generating source in the workspace: treat every mark as a review comment about it, not as an edit you can apply to the file;",
        );
        lines.push(
          "   address what each mark points at using its coordinates and the attached image, leave unmarked areas untouched, and do not claim the image itself was modified.",
        );
      }
    } else {
      lines.push(`   Location: ${JSON.stringify(reference.locator)}`);
      lines.push(`   Multimodal image attachment: ${reference.image.name}`);
      if (reference.nearbyText) lines.push(`   Nearby text: ${JSON.stringify(reference.nearbyText)}`);
    }
    lines.push(`   Reference JSON: ${JSON.stringify(serializableReference(reference))}`);
  });
  return `\n\n${lines.join("\n")}`;
}

export function stripContentReferencePromptBlock(content: unknown): string {
  const text = typeof content === "string" ? content : "";
  const markerIndex = text.indexOf(CONTENT_REFERENCE_PROMPT_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(0, markerIndex).trimEnd();
}

export function parseContentReferencePromptBlock(content: unknown): {
  content: string;
  references: ContentReference[];
} {
  const text = typeof content === "string" ? content : "";
  const markerIndex = text.indexOf(CONTENT_REFERENCE_PROMPT_MARKER);
  if (markerIndex < 0) return { content: text, references: [] };
  const visibleContent = stripContentReferencePromptBlock(text);
  const block = text.slice(markerIndex + CONTENT_REFERENCE_PROMPT_MARKER.length);
  const references: ContentReference[] = [];
  for (const match of block.matchAll(/^\s*Reference JSON:\s*(\{.*\})\s*$/gm)) {
    try {
      const parsed = JSON.parse(match[1]);
      const normalized = normalizeContentReference(parsed);
      if (normalized) references.push(normalized);
    } catch {
      // Ignore malformed compatibility payloads without hiding the user text.
    }
  }
  return { content: visibleContent, references };
}

/** 引用摘要的可选项：兜底文案与截断长度（用户可见文案由调用方按 i18n 提供）。 */
export type ContentReferenceSummaryOptions = {
  maxLength?: number;
  /** 区域引用的兜底文案。 */
  regionLabel?: string;
  /** 标注引用的条数文案；缺省退化为纯数字，不引入硬编码语种文案。 */
  annotationCountLabel?: (count: number) => string;
};

export function getContentReferenceSummary(
  reference: ContentReference,
  options: ContentReferenceSummaryOptions = {},
): string {
  const { maxLength = 160, regionLabel = "Region" } = options;
  let summary = "";
  if (reference.selectionMode === "text") {
    summary = reference.selectedText;
  } else if (reference.selectionMode === "cells") {
    summary = `${reference.locator.sheetName}!${reference.locator.ranges.join(", ")}`;
  } else if (reference.selectionMode === "annotation") {
    summary = annotationSummary(
      reference.annotation.document,
      options.annotationCountLabel ?? (count => String(count)),
    );
  } else {
    summary = regionLabel;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trimEnd()}...`;
}

export function contentReferenceImage(reference: ContentReference) {
  if (reference.selectionMode === "text" || reference.selectionMode === "cells") return null;
  if (!reference.image.dataUrl) return null;
  return {
    data: reference.image.dataUrl,
    name: reference.image.name,
    mimeType: reference.image.mimeType,
    size: Math.ceil(reference.image.dataUrl.length * 0.75),
  };
}
