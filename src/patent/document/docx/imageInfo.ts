/**
 * 图片头嗅探：从字节流读出格式与像素尺寸（仅解析文件头，不解码像素）。
 *
 * docx 嵌入图片需要两件事：① 正确的 media 扩展名 + 内容类型；② 用于
 * `<wp:extent>` 的宽高比例。两者都在文件头里，无需引入图像解码依赖。
 * 无法识别时返回 `undefined`，由调用方降级为「跳过该图并给出告警」。
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

/** 按签名嗅探图片格式；未识别返回 `undefined`。 */
export function probeImage(bytes: Uint8Array): ImageProbe | undefined {
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeGif(bytes) ?? probeBmp(bytes);
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
