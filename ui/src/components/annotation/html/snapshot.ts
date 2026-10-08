/**
 * 桥接快照的父页侧校验（H2）。
 *
 * 桥接运行在被标注文档内，是**不可信**的一侧（见 docs/html-annotation-plan.md §3.1）：
 * 这里对消息只做类型与长度校验，并用源文件字节（DOMParser，不执行脚本）校验每个 selector
 * ——命中且结构与声明一致才保留 selector，否则标记为运行时/不可解析并置空。
 *
 * 校验不过的消息不进入定位流程：宁可没有锚点，也不落一个源文件里不存在的 selector。
 */
import type { AnnotationAnchor } from "../../../types/annotationReference";
import {
  HTML_ANNOTATION_MAX_ANCHOR_ID_CHARS,
  HTML_ANNOTATION_MAX_ANCHOR_TEXT_CHARS,
  HTML_ANNOTATION_MAX_BBOX_PX,
  HTML_ANNOTATION_MAX_ELEMENTS,
  HTML_ANNOTATION_MAX_HEIGHT_PX,
  HTML_ANNOTATION_MAX_SELECTOR_CHARS,
} from "./constants";

/** 桥接发来的一条元素快照。除 `origin` 外均来自被标注文档，按不可信数据处理。 */
export type HtmlSnapshotElement = {
  /** 元素名（小写）。 */
  tag: string;
  /** 元素 id（可选）。 */
  id?: string;
  /** 元素文字（截断，可选）。 */
  text?: string;
  /** 文档坐标（含滚动偏移）的包围盒：[x, y, width, height]。 */
  bbox: readonly [number, number, number, number];
  /** 源文件定位路径；父页校验通过才保留。 */
  selector?: string;
  /** 父页校验结论：源解析可命中为 `static`，否则 `runtime`。 */
  origin?: "static" | "runtime";
};

/** 一份校验通过、且 selector 已按源文件复核过的快照。 */
export type HtmlSnapshot = {
  revision: number;
  height: number;
  /** 快照时刻框架窗口的滚动偏移（文档坐标 = 视口坐标 + scroll）。 */
  scroll: readonly [number, number];
  truncated: boolean;
  elements: HtmlSnapshotElement[];
};

/** 轻量的滚动更新（完整快照在滚动时太重，桥接用独立消息报告偏移）。 */
export type HtmlScrollUpdate = {
  revision: number;
  scroll: readonly [number, number];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 读取一条桥接消息；只接受 channel / nonce / 类型 / 长度全部合法的快照。
 *
 * @param data - `message` 事件的 `data`。
 * @param expected - 本挂载点生成并注入 URL 的频道与 nonce。
 * @returns 通过校验的快照，或其 `null`（调用方按"无有效快照"处理）。
 */
export function readHtmlSnapshotMessage(
  data: unknown,
  expected: { channel: string; nonce: string },
): HtmlSnapshot | null {
  if (!isRecord(data)) return null;
  if (data.channel !== expected.channel || data.nonce !== expected.nonce) return null;
  if (data.type !== "snapshot") return null;
  if (!isFiniteNumber(data.revision) || data.revision < 0) return null;
  if (!isFiniteNumber(data.height) || data.height < 0 || data.height > HTML_ANNOTATION_MAX_HEIGHT_PX) return null;
  if (!isScrollTuple(data.scroll)) return null;
  if (typeof data.truncated !== "boolean") return null;
  if (!Array.isArray(data.elements) || data.elements.length > HTML_ANNOTATION_MAX_ELEMENTS) return null;

  const elements: HtmlSnapshotElement[] = [];
  for (const raw of data.elements) {
    const element = readSnapshotElement(raw);
    if (element === null) return null;
    elements.push(element);
  }
  return {
    revision: data.revision,
    height: data.height,
    scroll: data.scroll,
    truncated: data.truncated,
    elements,
  };
}

/**
 * 读取一条滚动更新消息（与快照同一 channel/nonce；字段越界即拒绝）。
 *
 * @param data - `message` 事件的 `data`。
 * @param expected - 本挂载点生成并注入 URL 的频道与 nonce。
 * @returns 通过校验的滚动更新，或 `null`。
 */
export function readHtmlScrollMessage(
  data: unknown,
  expected: { channel: string; nonce: string },
): HtmlScrollUpdate | null {
  if (!isRecord(data)) return null;
  if (data.channel !== expected.channel || data.nonce !== expected.nonce) return null;
  if (data.type !== "scroll") return null;
  if (!isFiniteNumber(data.revision) || data.revision < 0) return null;
  if (!isScrollTuple(data.scroll)) return null;
  return { revision: data.revision, scroll: data.scroll };
}

function readSnapshotElement(value: unknown): HtmlSnapshotElement | null {
  if (!isRecord(value)) return null;
  if (typeof value.tag !== "string" || value.tag === "" || value.tag.length > 64) return null;
  if (!isBoundingBox(value.bbox)) return null;
  if (
    value.id !== undefined &&
    (typeof value.id !== "string" || value.id.length > HTML_ANNOTATION_MAX_ANCHOR_ID_CHARS)
  ) {
    return null;
  }
  if (
    value.text !== undefined &&
    (typeof value.text !== "string" || value.text.length > HTML_ANNOTATION_MAX_ANCHOR_TEXT_CHARS * 4)
  ) {
    return null;
  }
  if (
    value.selector !== undefined &&
    (typeof value.selector !== "string" ||
      value.selector === "" ||
      value.selector.length > HTML_ANNOTATION_MAX_SELECTOR_CHARS)
  ) {
    return null;
  }
  return {
    tag: value.tag,
    bbox: value.bbox,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.selector === undefined ? {} : { selector: value.selector }),
  };
}

function isBoundingBox(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(entry => isFiniteNumber(entry) && Math.abs(entry) <= HTML_ANNOTATION_MAX_BBOX_PX)
  );
}

function isScrollTuple(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(entry => isFiniteNumber(entry) && Math.abs(entry) <= HTML_ANNOTATION_MAX_HEIGHT_PX)
  );
}

/**
 * 消息是否来自目标框架窗口。
 *
 * opaque origin 下 `event.origin` 恒为 `"null"`，构不成判据；`event.source` 与框架
 * contentWindow 的同一性才是。调用方在挂 `message` 监听时传当前 iframe 的 contentWindow。
 */
export function isHtmlAnnotationSource(
  event: Pick<MessageEvent, "source">,
  expected: Window | null | undefined,
): boolean {
  return expected !== null && expected !== undefined && event.source === expected;
}

/**
 * 用源文件字节校验整个快照：每个 selector 必须在源解析 DOM 中命中、且 tag 与 `id` 与声明一致；
 * 不满足的元素保留包围盒（仍可画）但去掉 selector、标记为 `runtime`——运行时节点与源文件漂移
 * 都落在这一桶里，界面据此告知「只能定位到最近的可解析祖先/不可定位」。
 *
 * @param snapshot - 已通过消息校验的快照。
 * @param source - 源文件文本（raw 字节解码；DOMParser 不执行其中脚本）。
 * @returns 校验后的快照（新对象；不修改入参）。
 */
export function validateSnapshotAgainstSource(snapshot: HtmlSnapshot, source: string): HtmlSnapshot {
  const sourceDocument = new DOMParser().parseFromString(source, "text/html");
  const elements = snapshot.elements.map(element => {
    const selector = element.selector;
    if (selector === undefined) return { ...element, origin: "runtime" as const };
    let resolved: Element | null = null;
    try {
      resolved = sourceDocument.querySelector(selector);
    } catch {
      resolved = null;
    }
    if (resolved === null) {
      const { selector: _dropped, ...rest } = element;
      return { ...rest, origin: "runtime" as const };
    }
    if (resolved.tagName.toLowerCase() !== element.tag) {
      const { selector: _dropped, ...rest } = element;
      return { ...rest, origin: "runtime" as const };
    }
    if (element.id !== undefined && resolved.id !== element.id) {
      const { selector: _dropped, ...rest } = element;
      return { ...rest, origin: "runtime" as const };
    }
    return { ...element, origin: "static" as const };
  });
  return { ...snapshot, elements };
}

/**
 * 快照命中：文档坐标点上最小的包围盒。
 *
 * **未覆盖即无锚点**——不在快照里的区域（截断丢弃的、或文档在该点没有可命名元素）
 * 不返回祖先近似值。只有源解析复核为 `static` 的元素才带 `selector`；运行时节点
 * （`origin: "runtime"`）仍可被标注，但定位只靠坐标与说明。
 *
 * @param snapshot - 已通过消息校验与源解析复核的快照。
 * @param x - 文档坐标 x（视口坐标 + scroll）。
 * @param y - 文档坐标 y。
 * @returns 锚点，或 `undefined`。
 */
export function anchorAtSnapshotPoint(snapshot: HtmlSnapshot, x: number, y: number): AnnotationAnchor | undefined {
  let best: HtmlSnapshotElement | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const element of snapshot.elements) {
    const [left, top, width, height] = element.bbox;
    if (x < left || x > left + width || y < top || y > top + height) continue;
    const area = width * height;
    if (area < bestArea) {
      best = element;
      bestArea = area;
    }
  }
  if (best === null) return undefined;
  return {
    tag: best.tag,
    bbox: [best.bbox[0], best.bbox[1], best.bbox[2], best.bbox[3]],
    ...(best.id === undefined ? {} : { id: best.id }),
    ...(best.text === undefined ? {} : { text: best.text }),
    ...(best.selector === undefined ? {} : { selector: best.selector }),
  };
}
