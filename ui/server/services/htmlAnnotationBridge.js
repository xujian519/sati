/**
 * HTML 标注的注入桥接（H2）。
 *
 * 职责只有三件：生成快照（叶子优先、限额；selector 采用 dsh 同款语法，`#id` 仅在合法 id 上截断）、
 * 维护 revision（MutationObserver：attributes + childList）、把快照 postMessage 给父页。
 *
 * 安全边界（见 docs/html-annotation-plan.md §3.1）：桥接运行在被标注文档内，是**不可信**的一侧——
 * 它不发请求、不读存储、不做 eval；父页不信任它输出的任何字段，只把快照用于定位辅助。
 * **源解析校验在父页进行**（父页持有 raw 源字节、且是校验端）；桥接不读源文件，也不读凭据。
 */

/** 桥接与父页之间的消息频道。 */
export const HTML_ANNOTATION_CHANNEL = "sati-html-annotation";

/** 快照元素上限（叶子优先截断；超出部分命中即无锚点，不回退到祖先）。 */
export const HTML_ANNOTATION_MAX_ELEMENTS = 2000;

/** 单个 selector 的字符上限，超出即不输出（与 dsh 的读取截断不会静默分叉）。 */
export const HTML_ANNOTATION_MAX_SELECTOR_CHARS = 400;

/** 允许进入标注模式的文件字节上限（注入需要缓冲整个文件）。 */
export const ANNOTATABLE_MAX_BYTES = 8 * 1024 * 1024;

/** 快照重算的节流窗口（毫秒）。 */
export const HTML_ANNOTATION_THROTTLE_MS = 150;

/**
 * 桥接主体。**必须自包含**：不引用模块作用域的任何东西（注入时 `toString()` 后内联），
 * 参数经 JSON 传入。
 *
 * @param {{ channel: string, nonce: string, maxElements: number, maxSelectorChars: number, throttleMs: number }} params
 */
export function bridgeMain(params) {
  var doc = document;
  var revision = 0;
  var timer = null;
  var scrollTimer = null;

  function safeId(id) {
    return /^[A-Za-z][\w-]*$/.test(id);
  }

  /** The dsh path grammar: use `#id` only for a CSS-safe id, otherwise fall through to nth-of-type. */
  function selectorFor(el) {
    var segments = [];
    var rooted = false;
    var stop = doc.body || doc.documentElement;
    for (var cur = el; cur && cur !== stop; cur = cur.parentElement) {
      if (cur.id && safeId(cur.id)) {
        segments.unshift("#" + cur.id);
        rooted = true;
        break;
      }
      var tag = cur.tagName;
      var position = 1;
      for (var sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === tag) position += 1;
      }
      segments.unshift(tag.toLowerCase() + ":nth-of-type(" + position + ")");
    }
    if (!rooted) segments.unshift("body");
    return segments.join(" > ");
  }

  function depthBelow(el) {
    var depth = 0;
    for (var cur = el.parentElement; cur && cur !== doc.body; cur = cur.parentElement) depth += 1;
    return depth;
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var selector = null;
    try {
      var candidate = selectorFor(el);
      if (candidate.length <= params.maxSelectorChars) selector = candidate;
    } catch {
      /* A detached element has no path to name; it gets no selector instead. */
      selector = null;
    }
    var text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    var described = {
      tag: el.tagName.toLowerCase(),
      bbox: [rect.left + window.scrollX, rect.top + window.scrollY, rect.width, rect.height],
    };
    if (el.id) described.id = el.id;
    if (text) described.text = text;
    if (selector) described.selector = selector;
    return described;
  }

  function snapshot() {
    var body = doc.body;
    if (!body) return null;
    var candidates = [];
    var nodes = body.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i += 1) {
      var rect = nodes[i].getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      candidates.push({ el: nodes[i], depth: depthBelow(nodes[i]) });
    }
    // Leaf-first: deeper elements first (document order within one depth) so truncation drops shallow wrappers.
    candidates.sort(function (left, right) {
      return right.depth - left.depth;
    });
    var truncated = candidates.length > params.maxElements;
    var elements = [];
    var kept = candidates.slice(0, params.maxElements);
    for (var n = 0; n < kept.length; n += 1) elements.push(describe(kept[n].el));
    return {
      channel: params.channel,
      nonce: params.nonce,
      revision: revision,
      type: "snapshot",
      height: doc.documentElement ? doc.documentElement.scrollHeight : 0,
      scroll: [window.scrollX, window.scrollY],
      truncated: truncated,
      elements: elements,
    };
  }

  function post() {
    var message = snapshot();
    if (message === null) return;
    try {
      // An opaque origin forces targetOrigin `*`; safety comes from the parent checking source + nonce.
      (window.parent || window).postMessage(message, "*");
    } catch {
      /* Posting is best-effort; never throw into the annotated page. */
    }
  }

  function schedule() {
    if (timer !== null) return;
    timer = window.setTimeout(function () {
      timer = null;
      post();
    }, params.throttleMs);
  }

  function bump() {
    revision += 1;
    schedule();
  }

  /** Lightweight scroll updates: full snapshots are too heavy to post while scrolling. */
  function postScroll() {
    if (scrollTimer !== null) return;
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      try {
        (window.parent || window).postMessage(
          {
            channel: params.channel,
            nonce: params.nonce,
            type: "scroll",
            revision: revision,
            scroll: [window.scrollX, window.scrollY],
          },
          "*",
        );
      } catch {
        /* Scrolling updates are best-effort. */
      }
    }, 50);
  }

  try {
    var observer = new MutationObserver(bump);
    observer.observe(doc, { subtree: true, childList: true, attributes: true });
  } catch {
    /* Without MutationObserver there is no freshness signal; snapshots still work. */
  }

  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || data.channel !== params.channel || data.nonce !== params.nonce) return;
    if (data.type === "remeasure") {
      bump();
      return;
    }
    if (data.type === "scrollBy" && typeof data.dx === "number" && typeof data.dy === "number") {
      var dx = Math.max(-10000, Math.min(10000, data.dx));
      var dy = Math.max(-10000, Math.min(10000, data.dy));
      window.scrollBy(dx, dy);
    }
  });
  window.addEventListener("scroll", postScroll, { passive: true });
  window.addEventListener("resize", bump);
  window.addEventListener("load", schedule);

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", schedule);
    schedule();
  } else {
    schedule();
  }
  if (doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === "function") {
    doc.fonts.ready.then(schedule);
  }
}

/**
 * 把桥接主体序列化成可内联的脚本字符串（ASCII；字节级插入时不得引入非 ASCII 字节）。
 *
 * @param {{ nonce: string, throttleMs?: number }} options - nonce 由父页生成并经 URL 传入。
 * @returns {string} `<script>` 标签内容（不含标签本身）。
 */
export function buildHtmlAnnotationBridgeScript(options) {
  const params = {
    channel: HTML_ANNOTATION_CHANNEL,
    nonce: options.nonce,
    maxElements: HTML_ANNOTATION_MAX_ELEMENTS,
    maxSelectorChars: HTML_ANNOTATION_MAX_SELECTOR_CHARS,
    throttleMs: options.throttleMs ?? HTML_ANNOTATION_THROTTLE_MS,
  };
  const script = `(${bridgeMain.toString()})(${JSON.stringify(params)});`;
  // The script is spliced into raw bytes: keep it ASCII (plus whitespace) so it cannot corrupt an encoded file.
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script)) {
    throw new Error("the annotation bridge script must be printable ASCII");
  }
  return script;
}

/**
 * 在 doctype 之后、首个标签之前插入桥接脚本。
 *
 * **字节级**：不解码、不改动其余字节——GBK 等编码的文件不会被转码破坏，BOM 原样保留。
 * 无 doctype 时退化为文档最前插入（此分叉已由 H0 #8 记录：样本进入 BackCompat）。
 *
 * @param {Buffer} source - 原始文件字节。
 * @param {string} script - {@link buildHtmlAnnotationBridgeScript} 的输出。
 * @returns {{ bytes: Buffer, mode: "doctype" | "prepend" }} 注入后的字节与落点模式。
 */
export function injectHtmlAnnotationBridge(source, script) {
  const snippet = Buffer.from(`<script>${script}</script>`, "utf8");
  const latin = source.toString("latin1");
  // latin1 视图下一个字节 = 一个字符：BOM 是三个字符，不能写成 `\uFEFF`。
  const match = /^(?:\xEF\xBB\xBF)?\s*<!doctype[^>]*>/i.exec(latin);
  if (match === null) {
    return { bytes: Buffer.concat([snippet, source]), mode: "prepend" };
  }
  const at = match[0].length;
  return { bytes: Buffer.concat([source.subarray(0, at), snippet, source.subarray(at)]), mode: "doctype" };
}
