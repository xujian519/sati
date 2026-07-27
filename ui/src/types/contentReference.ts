import {
  createDocumentSelectionReference,
  isDocumentSelectionReference,
  type DocumentSelectionReference,
} from './documentSelection';

export const CONTENT_REFERENCE_ATTACHMENT_KIND = 'content-reference';
export const CONTENT_REFERENCE_PROMPT_MARKER = '[Content references selected by user:]';

export type ContentReferenceSelectionMode = 'text' | 'cells' | 'region';
export type ContentReferenceSurface = 'document' | 'page' | 'slide' | 'sheet' | 'editor';
export type ContentReferenceRendererId =
  | 'pdf'
  | 'office-pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text'
  | 'html'
  | 'image';
export type ContentReferenceLocatorQuality = 'semantic' | 'approximate' | 'visual';

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
  backend: 'builtin' | 'libreoffice';
  locatorQuality: ContentReferenceLocatorQuality;
};

export type ContentReferenceBase = {
  schemaVersion: 1;
  kind: typeof CONTENT_REFERENCE_ATTACHMENT_KIND;
  id: string;
  selectionMode: ContentReferenceSelectionMode;
  source: ContentReferenceSource;
  renderer: ContentReferenceRenderer;
  createdAt: string;
};

export type TextContentReference = ContentReferenceBase & {
  selectionMode: 'text';
  locator: {
    surface: Extract<ContentReferenceSurface, 'document' | 'page' | 'slide' | 'editor'>;
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
  selectionMode: 'cells';
  locator: {
    surface: 'sheet';
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
  selectionMode: 'region';
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
    mimeType: 'image/png';
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

export type ContentReference =
  | TextContentReference
  | CellRangeContentReference
  | ImageRegionContentReference;

export type ContentReferenceReasonCode =
  | 'NO_TEXT_LAYER'
  | 'NO_CELL_MODEL'
  | 'SURFACE_NOT_READY'
  | 'CAPTURE_UNAVAILABLE'
  | 'UNSUPPORTED_RENDERER';

export type CapabilityState = 'loading' | 'available' | 'unavailable';

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
  'schemaVersion' | 'kind' | 'id' | 'createdAt'
> & {
  id?: string;
  createdAt?: string;
};

function createReferenceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
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

function createContentReference<T extends ContentReference>(
  input: CreateContentReferenceInput<T>,
): T {
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
      ...(input.locator.rects
        ? { rects: input.locator.rects.map(normalizeRect) }
        : {}),
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

export function isContentReference(value: unknown): value is ContentReference {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ContentReference>;
  return candidate.kind === CONTENT_REFERENCE_ATTACHMENT_KIND
    && candidate.schemaVersion === 1
    && typeof candidate.id === 'string'
    && typeof candidate.selectionMode === 'string'
    && Boolean(candidate.source?.relativePath)
    && Boolean(candidate.source?.fileName);
}

export function documentSelectionToContentReference(
  reference: DocumentSelectionReference,
): TextContentReference {
  return createTextContentReference({
    id: reference.id,
    createdAt: reference.createdAt,
    selectionMode: 'text',
    source: {
      projectName: reference.projectName,
      relativePath: reference.filePath,
      fileName: reference.fileName,
    },
    renderer: {
      id: reference.source,
      backend: reference.source === 'office-pdf' ? 'libreoffice' : 'builtin',
      locatorQuality: reference.source === 'office-pdf' ? 'approximate' : 'semantic',
    },
    locator: {
      surface: 'page',
      pageNumbers: reference.pageNumbers,
      quote: { exact: reference.selectedText },
      occurrenceIndex: reference.occurrenceIndex,
    },
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    truncated: reference.truncated,
  });
}

export function normalizeContentReference(value: unknown): ContentReference | null {
  if (isContentReference(value)) return value;
  if (isDocumentSelectionReference(value)) return documentSelectionToContentReference(value);
  return null;
}

export function contentReferenceToLegacyDocumentSelection(
  reference: TextContentReference,
): DocumentSelectionReference {
  return createDocumentSelectionReference({
    id: reference.id,
    createdAt: reference.createdAt,
    projectName: reference.source.projectName,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    source: reference.renderer.id === 'pdf' ? 'pdf' : 'office-pdf',
    pageNumbers: reference.locator.pageNumbers || [],
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    occurrenceIndex: reference.locator.occurrenceIndex,
    truncated: reference.truncated,
  });
}

function compactMatrix<T>(values: T[][] | undefined, maxRows = 30, maxColumns = 20) {
  if (!values) return undefined;
  return values.slice(0, maxRows).map((row) => row.slice(0, maxColumns));
}

function serializableReference(reference: ContentReference): ContentReference {
  if (reference.selectionMode !== 'region') return reference;
  return {
    ...reference,
    image: {
      ...reference.image,
      dataUrl: undefined,
    },
  };
}

export function formatContentReferencePromptBlock(references: ContentReference[]): string {
  const valid = references.map(normalizeContentReference).filter(
    (reference): reference is ContentReference => Boolean(reference),
  );
  if (valid.length === 0) return '';

  const lines = [
    CONTENT_REFERENCE_PROMPT_MARKER,
    'These are immutable snapshots explicitly selected by the user. Use the source path as the default edit target when the request asks to modify the referenced content.',
  ];
  valid.forEach((reference, index) => {
    lines.push(`${index + 1}. ${reference.selectionMode.toUpperCase()} reference`);
    lines.push(`   Source: ${reference.source.relativePath}`);
    lines.push(`   Renderer: ${reference.renderer.id}/${reference.renderer.backend}; locator=${reference.renderer.locatorQuality}`);
    if (reference.selectionMode === 'text') {
      lines.push(`   Location: ${JSON.stringify(reference.locator)}`);
      lines.push(`   Selected text: ${JSON.stringify(reference.selectedText)}`);
      if (reference.surroundingText) {
        lines.push(`   Context: ${JSON.stringify(reference.surroundingText)}`);
      }
    } else if (reference.selectionMode === 'cells') {
      lines.push(`   Sheet: ${reference.locator.sheetName}; ranges=${reference.locator.ranges.join(', ')}`);
      lines.push(`   Cells: ${JSON.stringify(reference.cells.map((snapshot) => ({
        range: snapshot.range,
        displayValues: compactMatrix(snapshot.displayValues),
        rawValues: compactMatrix(snapshot.rawValues),
        formulas: compactMatrix(snapshot.formulas),
        rowCount: snapshot.rowCount,
        columnCount: snapshot.columnCount,
        truncated: snapshot.truncated,
      })))}`);
      if (reference.headers?.length) {
        lines.push(`   Nearby header rows: ${JSON.stringify(compactMatrix(reference.headers, 4, 30))}`);
      }
      if (reference.surroundingValues?.length) {
        lines.push(`   Nearby cells: ${JSON.stringify(compactMatrix(reference.surroundingValues, 20, 30))}`);
      }
    } else {
      lines.push(`   Location: ${JSON.stringify(reference.locator)}`);
      lines.push(`   Multimodal image attachment: ${reference.image.name}`);
      if (reference.nearbyText) lines.push(`   Nearby text: ${JSON.stringify(reference.nearbyText)}`);
    }
    lines.push(`   Reference JSON: ${JSON.stringify(serializableReference(reference))}`);
  });
  return `\n\n${lines.join('\n')}`;
}

export function stripContentReferencePromptBlock(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  const markerIndex = text.indexOf(CONTENT_REFERENCE_PROMPT_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(0, markerIndex).trimEnd();
}

export function parseContentReferencePromptBlock(content: unknown): {
  content: string;
  references: ContentReference[];
} {
  const text = typeof content === 'string' ? content : '';
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

export function getContentReferenceSummary(reference: ContentReference, maxLength = 160): string {
  let summary = '';
  if (reference.selectionMode === 'text') {
    summary = reference.selectedText;
  } else if (reference.selectionMode === 'cells') {
    summary = `${reference.locator.sheetName}!${reference.locator.ranges.join(', ')}`;
  } else {
    const surfaceNumber = reference.locator.pageNumber
      || reference.locator.slideNumber;
    summary = surfaceNumber
      ? `框选区域 · ${reference.locator.surface} ${surfaceNumber}`
      : '框选区域';
  }
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength).trimEnd()}...`;
}

export function contentReferenceImage(reference: ContentReference) {
  if (reference.selectionMode !== 'region' || !reference.image.dataUrl) return null;
  return {
    data: reference.image.dataUrl,
    name: reference.image.name,
    mimeType: reference.image.mimeType,
    size: Math.ceil(reference.image.dataUrl.length * 0.75),
  };
}
