/**
 * 把工作区里的一张 SVG 附图变成标注器可以命中的 DOM 子树，以及"标注落在哪个图元上"的解析。
 *
 * SVG 走**内联**而不是 `<img>`：只有活的 DOM 才知道标点落在哪个元素上。内联的图来自工作区
 * （可能被人工改过、也可能是外部 CAD/Graphviz 产物），所以先 sanitize 再进文档：脚本、
 * 外来内容元素、`on*` 事件属性、以及非 `#`/`data:` 的外部引用一律剥掉。
 *
 * 样式要单独洗：`<style>` 是**文档级**样式表（放进 shadow root 才关得住，见 FigureAnnotator），
 * 而 CSS 里的 `url()` 会真的发请求——外部引用改 `none`，定位声明整条去掉（附图靠坐标画，
 * 定位只可能用来把界面盖住）。
 *
 * 锚定优先读**机器可用的身份**：内置渲染器把节点写成 `<g id="n-<nodeId>" data-ref="<标号>">`，
 * 这两样能直接映射回 FigureSpec 的节点，比靠 `<title>` 猜要稳。
 */
import type { FigureAnnotationAnchor } from "../../../types/annotationReference";

/** 内联前整类删除的元素。 */
const FORBIDDEN_ELEMENTS = ["script", "foreignObject", "iframe", "audio", "video", "use", "animate", "set"];

/** 能承载 `url()` 的呈现属性：外联在这里同样会发请求。 */
const URL_ATTRIBUTES = [
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
];

/** `url(...)` 引用（允许带引号）。 */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;

/** shadow 里唯一能碰到宿主元素的钩子：留下一条就足以把整块界面挪走。 */
const SHADOW_HOST_HOOK = /::?host(?:\([^)]*\))?|::slotted(?:\([^)]*\))?/gi;

/**
 * 定位声明：附图用坐标画，`position` 只可能用来把图面（乃至界面）挪到别处。
 *
 * 按属性分两条正则删：一条正则同时匹配 `position` 与 `z-index` 时，前一条的匹配会把下一条的
 * 分隔符一起吃掉，相邻声明就漏掉了。
 */
const POSITIONING_DECLARATIONS = [/(^|[;{\s])position\s*:[^;}]+/gi, /(^|[;{\s])z-index\s*:[^;}]+/gi];

/**
 * 洗一段样式文本：外联引用改 `none`，宿主钩子与定位声明去掉。
 *
 * 这是**尽力而为**的一层（CSS 转义可以绕过属性名匹配），真正的边界是 shadow root 本身：
 * shadow 里的样式碰不到宿主以外的文档，能碰到宿主的只有 `:host`/`::slotted`。
 *
 * @returns 洗过的样式文本。
 */
function scrubCss(value: string): string {
  let scrubbed = value
    .replace(/@import[^;}]*;?/gi, "")
    .replace(CSS_URL, (match, quotedDouble, quotedSingle, bare) => {
      const target = String(quotedDouble ?? quotedSingle ?? bare)
        .trim()
        .toLowerCase();
      return target.startsWith("#") || target.startsWith("data:") ? match : "none";
    })
    .replace(SHADOW_HOST_HOOK, ":not(*)");
  for (const declaration of POSITIONING_DECLARATIONS) scrubbed = scrubbed.replace(declaration, "$1");
  return scrubbed;
}

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
    if (element.tagName.toLowerCase() === "style") element.textContent = scrubCss(element.textContent ?? "");
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const value = attribute.value.trim().toLowerCase();
        if (!value.startsWith("#") && !value.startsWith("data:")) element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style" || URL_ATTRIBUTES.includes(name)) attribute.value = scrubCss(attribute.value);
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
 * 无单位或 `px` 的 CSS 长度：只有这两种写法能当像素读。
 *
 * `width="100%"`、`width="210mm"`、`width="8.5in"` 的数值部分都不是像素——`parseFloat`
 * 会把它们读成 100 / 210 / 8.5 并当成图面尺寸，画布与导出尺寸随之失真。
 */
const PIXEL_LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/i;

/** 把 `width`/`height` 属性读成像素；带单位（含 `%`）或非法时返回 undefined。 */
function parsePixelLength(raw: string | null): number | undefined {
  const trimmed = (raw ?? "").trim();
  if (!PIXEL_LENGTH.test(trimmed)) return undefined;
  const value = Number.parseFloat(trimmed);
  return positive(value) ? value : undefined;
}

/**
 * 读一张内联 SVG 自己的尺寸：`width`/`height` 属性（仅无单位或 `px`）→ `viewBox` → 兜底 800x600。
 *
 * 带单位时不换算也不截取数值，而是整体回退 `viewBox`：附图靠自身的坐标系统绘制，
 * `viewBox` 才是与标注坐标自洽的参照系（`210mm` 换算成 794px 会得到一个与 `viewBox` 无关的尺寸）。
 */
export function svgIntrinsicSize(root: SVGSVGElement): FigureIntrinsicSize {
  const attributeWidth = parsePixelLength(root.getAttribute("width"));
  const attributeHeight = parsePixelLength(root.getAttribute("height"));
  if (attributeWidth !== undefined && attributeHeight !== undefined) {
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
 *
 * 图是内联在 shadow root 里的（文档级样式才关得住），所以查找从 shadow root 开始。
 */
export function anchorAtPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scaleX: number,
  scaleY: number,
): FigureAnnotationAnchor | undefined {
  const root = (container.shadowRoot ?? container).querySelector("svg");
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
