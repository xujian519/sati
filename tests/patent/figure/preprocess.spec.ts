/**
 * src/patent/figure — 附图预处理（`loadFigureImage`）与 MIME 映射测试。
 *
 * 这两个模块此前**无测试入口**：三级压缩级联（1600px/q80 → 1200px/q55 → 800px/q40）、
 * 字节预算守卫与 MIME 探测分支都只有 happy path 被工具层 spec 间接跑到，判据本身没有
 * 断言。这里补上：错误路径逐条（空文件 / 不可读 / 不可解码 / 压缩后仍超预算）、
 * 预算内原样返回、超预算触发压缩后 MIME 变 JPEG 且落在预算内。
 *
 * 图片由 sharp 现场生成，不提交二进制 fixture（与本仓 `pixel-gate.spec.ts` 同一手法）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIGURE_IMAGE_MIME_TYPES } from "../../../src/patent/figure/mime.js";
import { DEFAULT_MAX_FIGURE_BYTES, loadFigureImage } from "../../../src/patent/figure/preprocess.js";

/** 确定性伪随机噪声（LCG）：同一 seed 两次生成逐字节一致。 */
function noiseBytes(length: number, seed = 12345): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = (state >> 16) & 0xff;
  }
  return out;
}

/** 现场生成一张纯白 PNG（体积小，用于"预算内原样返回"路径）。 */
async function makePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
}

/**
 * 淡噪声 PNG（±8 灰度波动）：PNG 无损 ⇒ 每像素都要存（实测 400×400 约 43KB）；
 * JPEG 有损 ⇒ 小幅波动被量化掉（实测同图 q80 仅约 10KB）。
 * 这个「PNG 大、JPEG 小」的落差是压缩级联用例能确定性通过的前提——纯白图因 PNG 本身
 * 就小而不触发压缩，强噪声图则连 JPEG 也压不下来。
 */
async function makeSoftNoisePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const length = width * height * 3;
  const noise = noiseBytes(length);
  const raw = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    raw[index] = 128 + ((noise[index]! % 17) - 8);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function withTempDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-figure-preprocess-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("MIME 映射覆盖附图分析支持的格式（jpeg/jpg/png/gif/webp）", () => {
  assert.deepEqual(Object.keys(FIGURE_IMAGE_MIME_TYPES).sort(), ["gif", "jpeg", "jpg", "png", "webp"]);
  assert.equal(FIGURE_IMAGE_MIME_TYPES.png, "image/png");
  assert.equal(FIGURE_IMAGE_MIME_TYPES.jpg, "image/jpeg");
  assert.equal(FIGURE_IMAGE_MIME_TYPES.jpeg, "image/jpeg");
  assert.equal(FIGURE_IMAGE_MIME_TYPES.gif, "image/gif");
  assert.equal(FIGURE_IMAGE_MIME_TYPES.webp, "image/webp");
});

test("字节预算常量与附件解析器的图片上限一致（5 MiB）", () => {
  assert.equal(DEFAULT_MAX_FIGURE_BYTES, 5 * 1024 * 1024);
});

test(
  "loadFigureImage：预算内的 PNG 原样返回（不重编码、MIME 不变）",
  withTempDir(async dir => {
    const path = join(dir, "fig1.png");
    const png = await makePng(120, 90);
    writeFileSync(path, png);

    const prepared = await loadFigureImage(path);
    assert.equal(prepared.mimeType, "image/png");
    assert.equal(prepared.bytes, png.byteLength);
    assert.ok(prepared.buffer.equals(png), "预算内不得重编码（字节应逐字节一致）");
  }),
);

test(
  "loadFigureImage：空文件 → 报错（不静默当成零字节附件）",
  withTempDir(async dir => {
    const path = join(dir, "empty.png");
    writeFileSync(path, Buffer.alloc(0));
    await assert.rejects(() => loadFigureImage(path), /附图文件为空/u);
  }),
);

test(
  "loadFigureImage：文件不存在 → 报错并带出路径",
  withTempDir(async dir => {
    const path = join(dir, "missing.png");
    await assert.rejects(
      () => loadFigureImage(path),
      error => {
        assert.match(String(error), /无法读取附图文件/u);
        assert.match(String(error), /missing\.png/u);
        return true;
      },
    );
  }),
);

test(
  "loadFigureImage：非图像内容 → 报错（MIME 探测拒绝未知格式）",
  withTempDir(async dir => {
    const path = join(dir, "not-an-image.png");
    writeFileSync(path, "这不是图片", "utf8");
    await assert.rejects(() => loadFigureImage(path), /无法解码附图/u);
  }),
);

test(
  "loadFigureImage：超预算的 PNG → 压缩为 JPEG 且落在预算内",
  withTempDir(async dir => {
    const path = join(dir, "big.png");
    // 淡噪声 400×400：PNG 约 43KB，JPEG q80 约 10KB ⇒ 预算 30KB 必然触发压缩且能压下来
    const png = await makeSoftNoisePng(400, 400);
    assert.ok(png.byteLength > 30_000, `用例前提：淡噪声 PNG 应超预算，实际 ${png.byteLength} 字节`);
    writeFileSync(path, png);

    const prepared = await loadFigureImage(path, 30_000);
    assert.equal(prepared.mimeType, "image/jpeg", "压缩级联统一转 JPEG");
    assert.ok(prepared.bytes <= 30_000, `压缩后仍在预算内，实际 ${prepared.bytes}`);
    assert.ok(!prepared.buffer.equals(png), "压缩应改变字节");
  }),
);

test(
  "loadFigureImage：压缩后仍超预算 → fail-explicit（不返回超限附件）",
  withTempDir(async dir => {
    const path = join(dir, "huge.png");
    // `withoutEnlargement` 下 400px 宽的图不会被放大，故三级级联只能降质量、压不到 200
    // 字节以下 ⇒ 必须报错，而不是把超限附件交给模型
    writeFileSync(path, await makeSoftNoisePng(400, 400));
    await assert.rejects(() => loadFigureImage(path, 200), /超过模型大小预算/u);
  }),
);
