/**
 * 把工作区里的一张 SVG 附图变成标注器可以命中的 DOM 子树，以及"标注落在哪个图元上"的解析。
 *
 * SVG 走**内联**而不是 `<img>`：只有活的 DOM 才知道标点落在哪个元素上。内联的图来自工作区
 * （可能被人工改过、也可能是外部 CAD/Graphviz 产物），所以先 sanitize 再进文档：脚本、
 * 外来内容元素、`on*` 事件属性、以及非 `#`/`data:` 的外部引用一律剥掉。
 *
 * 锚定优先读**机器可用的身份**：内置渲染器把节点写成 `<g id="n-<nodeId>" data-ref="<标号>">`，
 * 这两样能直接映射回 FigureSpec 的节点，比靠 `<title>` 猜要稳。
 */
import type { FigureAnnotationAnchor } from "../../../types/annotationReference";

/** 内联前整类删除的元素。 */
const FORBIDDEN_ELEMENTS = ["script", "foreignObject", "iframe", "audio", "video", "use", "animate", "set"];

/** 带进锚定的元素文字上限。 */
const ANCHOR_TEXT_LIMIT = 80;

/** 不承载面积的元素，不参与命中。 */
const NON_SHAPE_ELEMENTS = ["title", "desc", "defs", "metadata", "style", "script"];

/** 内置渲染器的节点分组 id 前缀。 */
const NODE_ID_PREFIX = "n-";

/**
 * sanitize 一段 SVG 文本。
 *
 * @returns 解析出的根元素；文本不是可用 SVG 时返回 undefined。
 */
export function parseFigureSvg(source: string): SVGSVGElement | undefined {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") !== null) return undefined;
  const root = parsed.documentElement;
  if (root.tagName.toLowerCase() !== "svg") return undefined;
  for (const element of [...root.querySelectorAll(FORBIDDEN_ELEMENTS.join(","))]) element.remove();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const value = attribute.value.trim().toLowerCase();
        if (!value.startsWith("#") && !value.startsWith("data:")) element.removeAttribute(attribute.name);
      }
    }
  }
  return root as unknown as SVGSVGElement;
}

/** 序列化已 sanitize 的根元素（供导出与二次内联）。 */
export function figureSvgMarkup(root: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(root);
}

/** 图面固有尺寸。 */
export type FigureIntrinsicSize = {
  width: number;
  height: number;
};

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 读一张内联 SVG 自己的尺寸：`width`/`height` 属性 → `viewBox` → 兜底 800x600。
 */
export function svgIntrinsicSize(root: SVGSVGElement): FigureIntrinsicSize {
  const attributeWidth = Number.parseFloat(root.getAttribute("width") ?? "");
  const attributeHeight = Number.parseFloat(root.getAttribute("height") ?? "");
  if (positive(attributeWidth) && positive(attributeHeight)) {
    return { width: attributeWidth, height: attributeHeight };
  }
  const viewBox = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const [, , boxWidth, boxHeight] = viewBox;
  if (
    viewBox.length === 4 &&
    boxWidth !== undefined &&
    boxHeight !== undefined &&
    positive(boxWidth) &&
    positive(boxHeight)
  ) {
    return { width: boxWidth, height: boxHeight };
  }
  return { width: 800, height: 600 };
}

/** 内联图渲染时使用的 viewBox（没声明就用固有尺寸补一个）。 */
export function svgViewBox(root: SVGSVGElement, fallback: FigureIntrinsicSize): string {
  const declared = root.getAttribute("viewBox");
  if (declared !== null && declared.trim() !== "") return declared;
  return `0 0 ${fallback.width} ${fallback.height}`;
}

/** 元素在容器里的层级深度。 */
function depthBelow(element: Element, container: Element): number {
  let depth = 0;
  for (let node = element.parentElement; node !== null && node !== container; node = node.parentElement) depth += 1;
  return depth;
}

/** 从 `n-<nodeId>` 还原节点 id。 */
function nodeIdOf(element: Element): string | undefined {
  const id = element.getAttribute("id") ?? "";
  return id.startsWith(NODE_ID_PREFIX) && id.length > NODE_ID_PREFIX.length
    ? id.slice(NODE_ID_PREFIX.length)
    : undefined;
}

/** 元素是否自己声明了身份（锚定要落在它身上）。 */
function namesItself(element: Element): boolean {
  const id = element.getAttribute("id") ?? "";
  if (id !== "") return true;
  if ((element.getAttribute("data-ref") ?? "") !== "") return true;
  return element.querySelector(":scope > title") !== null;
}

/**
 * 描述图面上某个客户端坐标点落在哪个元素上。
 *
 * 命中判定遍历全部后代的包围盒，而不是问浏览器"指针下面是哪个元素"：专利附图大量是
 * `fill="none"` 的线条，无填充元素的内部不算命中，浏览器原生命中会对大面积图面答"根元素"。
 * 取**最小**的包含盒，再向上重指到最近一个"声明了自己身份"的祖先。
 */
export function anchorAtPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scaleX: number,
  scaleY: number,
): FigureAnnotationAnchor | undefined {
  const root = container.querySelector("svg");
  if (root === null) return undefined;
  let hit: Element | undefined;
  let hitArea = Number.POSITIVE_INFINITY;
  let hitDepth = -1;
  for (const element of root.querySelectorAll("*")) {
    if (NON_SHAPE_ELEMENTS.includes(element.tagName.toLowerCase())) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const area = rect.width * rect.height;
    const depth = depthBelow(element, container);
    if (area < hitArea || (area === hitArea && depth > hitDepth)) {
      hit = element;
      hitArea = area;
      hitDepth = depth;
    }
  }
  if (hit === undefined) return undefined;
  const hitText = (hit.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, ANCHOR_TEXT_LIMIT);
  let described = hit;
  for (let node: Element | null = hit; node !== null && node !== container; node = node.parentElement) {
    if (namesItself(node)) {
      described = node;
      break;
    }
  }
  const rect = described.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const title = described.querySelector(":scope > title")?.textContent?.trim();
  const ownText = (described.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, ANCHOR_TEXT_LIMIT);
  const text = ownText === "" ? hitText : ownText;
  const nodeId = nodeIdOf(described);
  const ref = (described.getAttribute("data-ref") ?? "").trim();
  const id = described.getAttribute("id") ?? "";
  return {
    tag: described.tagName.toLowerCase(),
    bbox: [
      (rect.left - containerRect.left) * scaleX,
      (rect.top - containerRect.top) * scaleY,
      rect.width * scaleX,
      rect.height * scaleY,
    ],
    ...(id === "" ? {} : { id }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(ref === "" ? {} : { ref }),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(text === "" ? {} : { text }),
  };
}
