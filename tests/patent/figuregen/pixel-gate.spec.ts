/**
 * src/patent/figuregen — 栅格附图像素级门禁测试（PX1 黑白 / PX2 线宽 / PX3 尺寸·DPI /
 * PX4 图号声明）。
 *
 * 纯函数（`analyzeGrayImage`）用构造的灰度缓冲测判据；解码路径用 sharp 现场生成的
 * PNG 走一遍（不提交二进制 fixture）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PIXEL_MAX_ANALYZE_PIXELS,
  analyzeGrayImage,
  analyzeImageBuffer,
  declaredFigureNoFromName,
  type GrayImage,
} from "../../../src/patent/figuregen/pixel-gate.js";

const WHITE = 255;
const BLACK = 0;

function blankImage(width: number, height: number, fill = WHITE): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

/** 横向黑条（thickness 像素厚），仅触左侧 marginPx 宽的一段。 */
function withBars(image: GrayImage, barCount: number, thickness: number, marginPx = 4): GrayImage {
  const data = Uint8Array.from(image.data);
  const barSpan = Math.floor(image.width / 2);
  for (let bar = 0; bar < barCount; bar += 1) {
    const top = marginPx + bar * (thickness + 6);
    for (let y = top; y < Math.min(image.height, top + thickness); y += 1) {
      for (let x = marginPx; x < marginPx + barSpan; x += 1) {
        data[y * image.width + x] = BLACK;
      }
    }
  }
  return { ...image, data };
}

test("PX1：中间灰占比过高判 fail；少量灰判 warn；纯黑白不触发", () => {
  const gray = analyzeGrayImage(blankImage(200, 200, 128));
  const grayFail = gray.findings.filter(f => f.rule === "PX1");
  assert.equal(grayFail.length, 1);
  assert.equal(grayFail[0].severity, "fail");
  assert.ok(grayFail[0].message.includes("灰度/着色"));

  // 非白像素中 10% 为中间灰 → warn（扫描抗锯齿量级）
  const speckled = withBars(blankImage(200, 200), 10, 2);
  const data = Uint8Array.from(speckled.data);
  let painted = 0;
  for (let i = 0; i < data.length && painted < 200; i += 1) {
    if (data[i] === BLACK) {
      data[i] = 140;
      painted += 1;
    }
  }
  const mixed = analyzeGrayImage({ ...speckled, data });
  const mixedFinding = mixed.findings.filter(f => f.rule === "PX1");
  assert.equal(mixedFinding.length, 1);
  assert.equal(mixedFinding[0].severity, "warn");

  const clean = analyzeGrayImage(withBars(blankImage(200, 200), 10, 2));
  assert.deepEqual(
    clean.findings.filter(f => f.rule === "PX1"),
    [],
  );
});

test("PX2：高 DPI 下过细线宽判 warn；线宽充足不触发", () => {
  const thin = analyzeGrayImage(withBars(blankImage(300, 300), 20, 1), { dpi: 300 });
  const thinLine = thin.findings.filter(f => f.rule === "PX2");
  assert.equal(thinLine.length, 1);
  assert.equal(thinLine[0].severity, "warn");
  assert.ok(thinLine[0].message.includes("最小可辨线宽"));
  assert.ok(thinLine[0].evidence?.some(e => e.includes("300")));
  assert.equal(thin.metrics.linePx, 1);

  const normal = analyzeGrayImage(withBars(blankImage(300, 300), 20, 4), { dpi: 150 });
  assert.deepEqual(
    normal.findings.filter(f => f.rule === "PX2"),
    [],
  );

  // 墨迹过少（run 样本不足）→ 不判线宽，如实说明跳过
  const sparse = analyzeGrayImage(blankImage(300, 300), { dpi: 150 });
  const sparseLine = sparse.findings.filter(f => f.rule === "PX2");
  assert.equal(sparseLine.length, 1);
  assert.equal(sparseLine[0].severity, "info");
  assert.ok(sparseLine[0].message.includes("跳过线宽判定"));
});

test("PX3：纸面尺寸超出可印区判 warn；尺寸在框内不触发；判据按法域档案", () => {
  // 3000px @96dpi ≈ 793mm，远超 170×257mm
  const oversize = analyzeGrayImage(withBars(blankImage(3000, 400), 20, 3));
  const sizeFinding = oversize.findings.filter(f => f.rule === "PX3" && f.message.includes("可印区"));
  assert.equal(sizeFinding.length, 1);
  assert.equal(sizeFinding[0].severity, "warn");
  assert.ok(sizeFinding[0].message.includes("cnipa"), "报告须写明按哪套法域档案判定");
  assert.ok(oversize.metrics.printedWidthMm !== undefined && oversize.metrics.printedWidthMm > 170);

  const small = analyzeGrayImage(withBars(blankImage(400, 300), 10, 3));
  assert.deepEqual(
    small.findings.filter(f => f.rule === "PX3" && f.message.includes("可印区")),
    [],
  );
});

test("PX3：可印区判据按法域档案取（uspto 下边距 10mm ⇒ 版心更高）", () => {
  // 630×985px @96dpi ≈ 166.7×260.6mm：cnipa 版心 170×257mm 判 warn（超高），
  // uspto 版心 168.7×261.6mm 不超 —— 同一张图在两套档案下结论不同，证明判据确实按档案取。
  const image = withBars(blankImage(630, 985), 40, 3);
  const cnipa = analyzeGrayImage(image, { office: "cnipa" });
  const uspto = analyzeGrayImage(image, { office: "uspto" });
  assert.equal(cnipa.findings.filter(f => f.rule === "PX3" && f.message.includes("可印区")).length, 1);
  assert.equal(uspto.findings.filter(f => f.rule === "PX3" && f.message.includes("可印区")).length, 0);
});

test("PX3：DPI 越界判 warn 并标注估算/元数据来源", () => {
  const low = analyzeGrayImage(withBars(blankImage(400, 300), 10, 3), { dpi: 40 });
  const lowFinding = low.findings.filter(f => f.rule === "PX3" && f.message.includes("DPI"));
  assert.equal(lowFinding.length, 1);
  assert.equal(low.metrics.dpiEstimated, false);

  const estimated = analyzeGrayImage(withBars(blankImage(400, 300), 10, 3));
  assert.equal(estimated.metrics.dpi, 96);
  assert.equal(estimated.metrics.dpiEstimated, true);
});

test("PX3：超大图跳过逐像素分析并说明（不假装已核验）", () => {
  // 只声明尺寸、不给像素：guard 在扫描前返回（data 长度不参与该判定）
  const huge = analyzeGrayImage({ width: 6000, height: 5000, data: new Uint8Array(1) });
  assert.ok(6000 * 5000 > PIXEL_MAX_ANALYZE_PIXELS);
  const finding = huge.findings.filter(f => f.rule === "PX3" && f.message.includes("跳过像素级核查"));
  assert.equal(finding.length, 1);
  assert.equal(finding[0].severity, "info");
});

test("PX4：图号声明缺失判 warn；文件名/显式声明命中则给 info", () => {
  assert.equal(declaredFigureNoFromName("case-a-fig3.png"), 3);
  assert.equal(declaredFigureNoFromName("附图_图12.jpg"), 12);
  assert.equal(declaredFigureNoFromName("scan001.png"), undefined);
  assert.equal(declaredFigureNoFromName("2024-报告.png"), undefined);

  const undeclared = analyzeGrayImage(withBars(blankImage(300, 300), 10, 3), { name: "scan001.png" });
  const undeclaredPx4 = undeclared.findings.filter(f => f.rule === "PX4");
  assert.equal(undeclaredPx4.length, 1);
  assert.equal(undeclaredPx4[0].severity, "warn");
  assert.ok(undeclaredPx4[0].message.includes("不做 OCR"));

  const declared = analyzeGrayImage(withBars(blankImage(300, 300), 10, 3), { name: "case-a-fig3.png" });
  const declaredPx4 = declared.findings.filter(f => f.rule === "PX4");
  assert.equal(declaredPx4.length, 1);
  assert.equal(declaredPx4[0].severity, "info");
  assert.equal(declared.metrics.declaredFigureNo, 3);
});

test("解码路径：sharp 现场生成 PNG（黑白线条）→ 指标与发现", async () => {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="400" height="300" fill="#FFFFFF"/>' +
      '<rect x="20" y="20" width="360" height="6" fill="#000000"/>' +
      '<rect x="20" y="60" width="200" height="6" fill="#000000"/>' +
      "</svg>",
  );
  const png = await sharp(svg).png().toBuffer();
  const result = await analyzeImageBuffer(png, { name: "clean-fig1.png" });
  assert.equal(result.metrics.width, 400);
  assert.equal(result.metrics.height, 300);
  // sharp 输出的 PNG 自带 density（默认 72），故走元数据分支（估算分支见上一条纯函数用例）
  assert.ok(result.metrics.dpi >= 72, `DPI 应来自元数据（实际 ${result.metrics.dpi}）`);
  assert.ok(result.metrics.inkRatio > 0 && result.metrics.inkRatio < 0.1);
  assert.deepEqual(
    result.findings.filter(f => f.severity === "fail"),
    [],
  );
  assert.ok(result.metrics.printedWidthMm !== undefined && result.metrics.printedWidthMm < 170);

  // 灰度底 → PX1 fail（同一解码路径）
  const grayPng = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .png()
    .toBuffer();
  const grayResult = await analyzeImageBuffer(grayPng, { name: "shaded-fig2.png" });
  assert.ok(grayResult.findings.some(f => f.rule === "PX1" && f.severity === "fail"));
});
