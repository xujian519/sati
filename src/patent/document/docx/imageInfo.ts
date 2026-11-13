/**
 * 图片头嗅探：从字节流读出格式与像素尺寸（仅解析文件头，不解码像素）。
 *
 * docx 嵌入图片需要两件事：① 正确的 media 扩展名 + 内容类型；② 用于
 * `<wp:extent>` 的宽高比例。两者都在文件头里，无需引入图像解码依赖。
 * 无法识别时返回 `undefined`，由调用方降级为「跳过该图并给出告警」。
 *
 * 位图（PNG/JPEG/GIF/BMP）走文件头嗅探；**SVG 是矢量**，没有文件头，改按根标签的
 * `width`/`height`（`viewBox` 兜底）探测尺寸。它进 docx 前还要先栅格化成 PNG
 * （见 `figureRaster.ts`）——OOXML 的图片关系只认位图。
 */

/** 图片头解析结果。 */
export type ImageProbe = {
  /** 小写扩展名（不含点），用作 `word/media/` 文件名后缀。 */
  ext: string;
  /** OOXML 内容类型。 */
  contentType: string;
  /** 像素宽。 */
  widthPx: number;
  /** 像素高。 */
  heightPx: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32be(bytes: Uint8Array, offset: number): number {
  const v =
    ((bytes[offset] ?? 0) * 0x1000000 +
      (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))) >>>
    0;
  return v;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** PNG：签名 + IHDR（宽高为大端 32 位）。 */
function probePng(bytes: Uint8Array): ImageProbe | undefined {
  if (!matches(bytes, 0, PNG_SIGNATURE)) return undefined;
  if (!matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return undefined; // "IHDR"
  const widthPx = u32be(bytes, 16);
  const heightPx = u32be(bytes, 20);
  if (widthPx === 0 || heightPx === 0) return undefined;
  return { ext: "png", contentType: "image/png", widthPx, heightPx };
}

/** JPEG：SOI 后逐段扫描，命中 SOFn 段读取宽高（大端 16 位）。 */
function probeJpeg(bytes: Uint8Array): ImageProbe | undefined {
  if (!matches(bytes, 0, [0xff, 0xd8])) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined; // 段边界丢失，放弃
    const marker = bytes[offset + 1] ?? 0;
    // 填充字节 0xFF 可重复出现。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    // SOF0-SOF15，排除 DHT(0xC4)/JPG(0xC8)/DAC(0xCC)。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const heightPx = u16be(bytes, offset + 5);
      const widthPx = u16be(bytes, offset + 7);
      if (widthPx === 0 || heightPx === 0) return undefined;
      return { ext: "jpg", contentType: "image/jpeg", widthPx, heightPx };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** GIF：逻辑屏幕描述符宽高（小端 16 位）。 */
function probeGif(bytes: Uint8Array): ImageProbe | undefined {
  const isGif = matches(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39);
  if (!isGif) return undefined;
  const widthPx = u16le(bytes, 6);
  const heightPx = u16le(bytes, 8);
  if (widthPx === 0 || heightPx === 0) return undefined;
  return { ext: "gif", contentType: "image/gif", widthPx, heightPx };
}

/** BMP：DIB 头宽高（小端 32 位；高度为负表示自上而下，取绝对值）。 */
function probeBmp(bytes: Uint8Array): ImageProbe | undefined {
  if (!matches(bytes, 0, [0x42, 0x4d])) return undefined;
  const widthPx = Math.abs(u32le(bytes, 18) | 0);
  const heightPx = Math.abs(u32le(bytes, 22) | 0);
  if (widthPx === 0 || heightPx === 0) return undefined;
  return { ext: "bmp", contentType: "image/bmp", widthPx, heightPx };
}

/** SVG 根元素的开始标签（只取开始标签；属性里的 '>' 不影响匹配）。 */
const SVG_OPEN_TAG = /<svg\b[^>]*>/i;

/**
 * 读根元素属性值（属性名不区分大小写）。
 *
 * 用 `(?:^|\s)` 开头而不是 `\b`：`\b` 挡不住 `stroke-width=`（`-` 也是词边界），
 * 查 `width` 会读到描边宽度，把 100mm 的画幅读成 0.13mm（与
 * `figuregen/svg-viewport.ts` 同一个坑）。
 */
function svgAttribute(openTag: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "i");
  return pattern.exec(openTag)?.[1];
}

/** SVG 长度值 → CSS 像素（96dpi）；百分比等相对单位脱离上下文不可用，返回 undefined。 */
function svgLengthToCssPx(raw: string): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)\s*$/i.exec(raw);
  if (match === null) return undefined;
  const value = Number(match[1]);
  switch ((match[2] ?? "").toLowerCase()) {
    case "":
    case "px":
      return value;
    case "in":
      return value * 96;
    case "cm":
      return (value / 2.54) * 96;
    case "mm":
      return (value / 25.4) * 96;
    case "pt":
      return (value / 72) * 96;
    default:
      return undefined;
  }
}

/**
 * 是否是 SVG（只看有没有 `<svg` 根标签，不问尺寸）。
 *
 * 与 `probeImage` 分开：一张**尺寸不可判定**的 SVG（既无 width/height 也无 viewBox）
 * 仍然是 SVG——它只是没法定尺寸，失败原因应当报「SVG 栅格化失败」，
 * 而不是笼统的「图片格式不受支持」（后者会让人以为文件根本不是图）。
 * @param bytes - 图片字节。
 * @returns 疑似 SVG 时 true。
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return SVG_OPEN_TAG.test(text);
}

/**
 * SVG：按根标签 + `width`/`height`（`viewBox` 兜底）探测像素尺寸。
 *
 * **只做尺寸探测，不栅格化**：矢量附图进 docx 前要经 `figureRaster.ts` 转成 PNG，
 * 这里给出的宽高只用于计算显示比例（纵横比必须与栅格化产物一致，故这里也按
 * 96dpi 的物理尺寸换算）。
 */
function probeSvg(bytes: Uint8Array): ImageProbe | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const openTag = SVG_OPEN_TAG.exec(text)?.[0];
  if (openTag === undefined) return undefined;
  const widthAttr = svgAttribute(openTag, "width");
  const heightAttr = svgAttribute(openTag, "height");
  const viewBoxAttr = svgAttribute(openTag, "viewBox");
  let viewBoxWidth: number | undefined;
  let viewBoxHeight: number | undefined;
  if (viewBoxAttr !== undefined) {
    const parts = viewBoxAttr
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts.every(value => Number.isFinite(value))) {
      viewBoxWidth = parts[2];
      viewBoxHeight = parts[3];
    }
  }
  const widthPx = (widthAttr === undefined ? undefined : svgLengthToCssPx(widthAttr)) ?? viewBoxWidth;
  const heightPx = (heightAttr === undefined ? undefined : svgLengthToCssPx(heightAttr)) ?? viewBoxHeight;
  if (widthPx === undefined || heightPx === undefined) return undefined;
  if (widthPx <= 0 || heightPx <= 0) return undefined;
  return { ext: "svg", contentType: "image/svg+xml", widthPx, heightPx };
}

/**
 * 按签名嗅探图片格式；未识别返回 `undefined`。
 *
 * 位图分支（PNG/JPEG/GIF/BMP）只看文件头，行为不变；SVG 排在其后——
 * 二者互斥（位图签名不可能是 `<svg`），故新增 SVG 不会改变既有判定。
 */
export function probeImage(bytes: Uint8Array): ImageProbe | undefined {
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeGif(bytes) ?? probeBmp(bytes) ?? probeSvg(bytes);
}

/** 解析 `data:` URI；非 data URI 或未携带 base64 载荷时返回 `undefined`。 */
export function decodeDataUri(src: string): { bytes: Uint8Array; declaredMime?: string } | undefined {
  const match = /^data:([^;,]*)((?:;[^,;]*)*),(.*)$/s.exec(src.trim());
  if (match === null) return undefined;
  const meta = match[2] ?? "";
  const payload = match[3] ?? "";
  if (!/;base64/i.test(meta)) {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), declaredMime: match[1] || undefined };
  }
  return { bytes: Buffer.from(payload.replace(/\s+/g, ""), "base64"), declaredMime: match[1] || undefined };
}
