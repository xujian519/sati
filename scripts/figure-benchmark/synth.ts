/**
 * scripts/figure-benchmark/synth.ts — 合成电学附图基准数据生成器。
 *
 * 生成专利风格的电路原理图（黑白线图 + 标准符号 + 附图标记），用于
 * analyze_patent_figure 电学深度分析（Step3）的自动化评估，补充真实
 * 数据集覆盖：
 *   - 标准符号画法（GB/T 4728 简化）：电阻/电容/LED/电池/地/运放/三极管
 *   - 常见拓扑：LED 指示电源电路、RC 滤波、同相放大、三极管开关
 *   - 标号带偏移：同一模板可生成多张内容不同的图（标号数字不同）
 *
 * 输出：PNG 写入 ~/.sati/benchmark/figures/，返回 manifest 条目（含电学
 * ground truth），由 run.ts 的 --synth N 参数调用。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FigureType } from "../../src/patent/figure/types.js";

export const BENCHMARK_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".sati", "benchmark");
export const SYNTH_FIGURES_DIR = path.join(BENCHMARK_DIR, "figures");

/** 电学 ground truth（与 FigureAnalysisResult.electrical 对齐的预期值）。 */
export type SyntheticElectricalGroundTruth = {
  components: { ref: string; symbol: string }[];
  nets: { name: string; connectedRefs: string[] }[];
};

export type SyntheticBenchmarkFigure = {
  id: string;
  imageFile: string;
  sourceCase: string;
  sourceFile: string;
  figureNumber: number;
  title: string;
  humanFigureType: FigureType;
  expectedRefNumbers: string[];
  keyComponents: { refNumber: string; name: string }[];
  expectedElectrical: SyntheticElectricalGroundTruth;
  notes?: string;
};

/* ---------------- SVG 绘制帮助函数（专利黑白线图风格） ---------------- */

const STROKE = 'stroke="black" fill="none" stroke-width="2"';

function svg(width: number, height: number, elements: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
    ...elements,
    "</svg>",
  ].join("\n");
}

/** line：extra 可覆盖 stroke-width（如细线箭头）。 */
const line = (x1: number, y1: number, x2: number, y2: number, extra = "") =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="black" fill="none" ${extra || 'stroke-width="2"'}/>`;
const rect = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${STROKE}/>`;
const poly = (points: string, extra = "") =>
  `<polyline points="${points}" stroke="black" fill="none" ${extra || 'stroke-width="2"'}/>`;
const label = (x: number, y: number, s: string) =>
  `<text x="${x}" y="${y}" font-size="14" fill="black" font-family="sans-serif">${s}</text>`;
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="3" fill="black" stroke="none"/>`;

function resistorSvg(x: number, y: number): string[] {
  const bodyW = 36;
  const bodyH = 14;
  return [
    line(x, y, x + 10, y),
    rect(x + 10, y - bodyH / 2, bodyW, bodyH),
    line(x + 10 + bodyW, y, x + 10 + bodyW + 10, y),
  ];
}

/** 垂直电容（x 为中心线，y 为顶部端点），返回底部端点 y。 */
function capacitorSvg(x: number, y: number): string[] {
  const plateGap = 10;
  const plateH = 30;
  return [
    line(x, y, x, y + 8),
    line(x, y + 8, x, y + 8 + plateH),
    line(x + plateGap, y + 8, x + plateGap, y + 8 + plateH),
    line(x + plateGap, y + 8 + plateH, x + plateGap, y + 8 + plateH + 8),
  ];
}

/** 垂直 LED（阳极在上，阴极在下）：三角 + 横线 + 发光箭头。 */
function ledSvg(x: number, y: number): string[] {
  const tipY = y + 22;
  const baseY = y + 42;
  return [
    line(x, y, x, y + 8),
    poly(`${x - 12},${tipY} ${x + 12},${tipY} ${x},${y + 8}`),
    line(x - 12, tipY, x + 12, tipY),
    line(x, tipY, x, baseY),
    // 发光箭头
    poly(`${x - 18},${tipY - 6} ${x - 10},${tipY + 2}`, 'stroke-width="1.5"'),
    poly(`${x + 18},${tipY - 6} ${x + 10},${tipY + 2}`, 'stroke-width="1.5"'),
  ];
}

/** 垂直电池（正极长线在上，负极短线在下）。 */
function batterySvg(x: number, y: number): string[] {
  const topY = y + 8;
  return [
    line(x, y, x, topY),
    line(x, topY, x, topY + 12),
    line(x + 8, topY + 4, x + 8, topY + 12),
    line(x, topY + 12, x, topY + 20),
    line(x + 8, topY + 12, x + 8, topY + 20),
    line(x, topY + 20, x, topY + 28),
    line(x + 8, topY + 20, x + 8, topY + 28),
  ];
}

/** 地符号（x 为竖线中心，y 为顶部端点）。 */
function groundSvg(x: number, y: number): string[] {
  return [
    line(x, y, x, y + 12),
    line(x - 12, y + 12, x + 12, y + 12),
    line(x - 8, y + 18, x + 8, y + 18),
    line(x - 4, y + 24, x + 4, y + 24),
  ];
}

/* ---------------- 电路模板（返回 SVG 元素 + ground truth） ---------------- */

type Template = {
  id: string;
  title: string;
  figureType: FigureType;
  width: number;
  height: number;
  draw: (offset: number) => { elements: string[]; gt: SyntheticElectricalGroundTruth };
};

const POWER_LED_TEMPLATE: Template = {
  id: "power-led",
  title: "LED 指示电源电路",
  figureType: "circuit",
  width: 300,
  height: 260,
  draw(offset) {
    const r = 1 + offset;
    const d = 1 + offset;
    const bat = 1 + offset;
    const x = 90;
    const elements: string[] = [];
    // 电池 BAT
    elements.push(...batterySvg(x, 20));
    elements.push(label(x - 30, 34, `BAT${bat}`));
    // 电阻 R
    elements.push(...resistorSvg(x, 100));
    elements.push(label(x - 30, 96, `R${r}`));
    elements.push(dot(x + 46, 100));
    // LED D
    elements.push(...ledSvg(x, 140));
    elements.push(label(x - 34, 160, `D${d}`));
    // GND
    elements.push(...groundSvg(x, 240));
    elements.push(label(x - 34, 232, "GND"));
    // 连线（电池→电阻→LED→地）
    elements.push(line(x, 20 + 8 + 28, x, 100));
    elements.push(line(x + 46, 100, x + 46, 140));
    elements.push(line(x, 140 + 42, x, 240));
    return {
      elements,
      gt: {
        components: [
          { ref: `BAT${bat}`, symbol: "battery" },
          { ref: `R${r}`, symbol: "resistor" },
          { ref: `D${d}`, symbol: "led" },
        ],
        nets: [
          { name: "N1", connectedRefs: [`BAT${bat}.1`, `R${r}.1`] },
          { name: "N2", connectedRefs: [`R${r}.2`, `D${d}.1`] },
          { name: "GND", connectedRefs: [`BAT${bat}.2`, `D${d}.2`] },
        ],
      },
    };
  },
};

const RC_FILTER_TEMPLATE: Template = {
  id: "rc-filter",
  title: "RC 滤波电路",
  figureType: "circuit",
  width: 320,
  height: 220,
  draw(offset) {
    const r = 2 + offset;
    const c = 1 + offset;
    const elements: string[] = [];
    // VIN 输入
    elements.push(line(20, 80, 40, 80));
    elements.push(label(12, 74, "VIN"));
    elements.push(dot(20, 80));
    // 电阻 R（水平 40..146）
    elements.push(...resistorSvg(40, 80));
    elements.push(label(84, 68, `R${r}`));
    elements.push(dot(146, 80));
    // 电容 C（垂直，上端接 146,80，下端接地）
    elements.push(...capacitorSvg(160, 80));
    elements.push(label(168, 74, `C${c}`));
    // 地
    elements.push(...groundSvg(160, 80 + 8 + 30 + 16));
    elements.push(label(172, 146, "GND"));
    // VOUT 输出
    elements.push(line(160 + 10, 80 + 8 + 30 + 8, 160 + 10 + 60, 80 + 8 + 30 + 8));
    elements.push(dot(160 + 10, 80 + 8 + 30 + 8));
    elements.push(label(230, 112, "VOUT"));
    return {
      elements,
      gt: {
        components: [
          { ref: `R${r}`, symbol: "resistor" },
          { ref: `C${c}`, symbol: "capacitor" },
        ],
        nets: [
          { name: "VIN", connectedRefs: [`R${r}.1`] },
          { name: "N1", connectedRefs: [`R${r}.2`, `C${c}.1`] },
          { name: "GND", connectedRefs: [`C${c}.2`] },
        ],
      },
    };
  },
};

const OPAMP_TEMPLATE: Template = {
  id: "opamp-amp",
  title: "同相放大电路",
  figureType: "circuit",
  width: 360,
  height: 240,
  draw(offset) {
    const r1 = 1 + offset;
    const r2 = 2 + offset;
    const u = 1 + offset;
    const elements: string[] = [];
    // 运放 U1：三角 (180,135)(180,165)(220,150)，反相输入 (180,140)，正相输入 (180,160)
    const ux = 180;
    const uy = 150;
    elements.push(poly(`${ux},${uy - 15} ${ux},${uy + 15} ${ux + 40},${uy}`));
    // 正相输入线（下方 y=160）+ R1 输入电阻
    elements.push(line(30, 160, 40, 160));
    elements.push(label(22, 154, "VIN"));
    elements.push(...resistorSvg(40, 160));
    elements.push(label(78, 148, `R${r1}`));
    elements.push(line(96, 160, ux, 160));
    elements.push(label(ux - 26, uy + 18, "+"));
    elements.push(dot(ux, 160));
    // 反相输入（上方 y=140，反馈线贴三角左边界下来相接）
    elements.push(label(ux - 26, uy - 16, "−"));
    elements.push(dot(ux, 140));
    elements.push(label(ux + 6, uy - 28, `U${u}`));
    // 输出线
    elements.push(line(ux + 40, uy, ux + 40 + 60, uy));
    elements.push(dot(ux + 100, uy));
    elements.push(label(ux + 92, uy - 10, "VOUT"));
    // 反馈 R2：输出点上拐 → 电阻 → 贴三角左边界下拐接反相输入
    const fbX = ux + 70; // 250
    elements.push(line(fbX, uy, fbX, 90));
    elements.push(line(fbX, 90, ux + 56, 90));
    elements.push(...resistorSvg(ux - 0, 90)); // 电阻左端 x=180 → 右端 236
    elements.push(label(ux + 20, 78, `R${r2}`));
    elements.push(line(ux, 90, ux, 140));
    elements.push(dot(ux, 90));
    // 电源引脚
    elements.push(line(ux + 20, uy - 15, ux + 20, 120));
    elements.push(label(ux + 26, 118, "VCC"));
    elements.push(line(ux + 20, uy + 15, ux + 20, 180));
    elements.push(label(ux + 26, 194, "VEE"));
    return {
      elements,
      gt: {
        components: [
          { ref: `R${r1}`, symbol: "resistor" },
          { ref: `R${r2}`, symbol: "resistor" },
          { ref: `U${u}`, symbol: "opamp" },
        ],
        nets: [
          { name: "VIN", connectedRefs: [`R${r1}.1`] },
          { name: "N1", connectedRefs: [`R${r1}.2`, `U${u}.1`] },
          { name: "N2", connectedRefs: [`R${r2}.1`, `U${u}.2`] },
          { name: "N3", connectedRefs: [`R${r2}.2`, `U${u}.3`] },
          { name: "VCC", connectedRefs: [`U${u}.4`] },
          { name: "VEE", connectedRefs: [`U${u}.5`] },
        ],
      },
    };
  },
};

const TRANSISTOR_SWITCH_TEMPLATE: Template = {
  id: "transistor-switch",
  title: "三极管开关电路",
  figureType: "circuit",
  width: 340,
  height: 260,
  draw(offset) {
    const r1 = 1 + offset;
    const r2 = 2 + offset;
    const q = 1 + offset;
    const elements: string[] = [];
    // 输入 VIN → R1 → 基极（y=100）
    elements.push(line(20, 100, 40, 100));
    elements.push(label(12, 94, "VIN"));
    elements.push(...resistorSvg(40, 100));
    elements.push(label(80, 88, `R${r1}`));
    elements.push(line(96, 100, 150, 100));
    // 三极管 Q1：基极竖线 (150,60..160)，集电极斜线 (150,60)→(176,70)，发射极斜线 (150,160)→(176,150)
    const qx = 150;
    elements.push(line(qx, 100, qx, 60));
    elements.push(line(qx, 100, qx, 160));
    elements.push(poly(`${qx},${60} ${qx + 26},${70} ${qx + 2},${76}`));
    elements.push(poly(`${qx},${160} ${qx + 26},${150} ${qx + 2},${152}`));
    elements.push(label(qx - 30, 116, `Q${q}`));
    // 集电极电阻 R2（水平 y=60，右端接 VCC）
    elements.push(line(qx, 60, qx + 10, 60));
    elements.push(...resistorSvg(qx + 10, 60));
    elements.push(label(qx + 30, 48, `R${r2}`));
    elements.push(line(qx + 66, 60, qx + 66, 40));
    elements.push(label(qx + 74, 34, "VCC"));
    elements.push(dot(qx + 66, 60));
    // 发射极 → GND（y=160 下方）
    elements.push(...groundSvg(qx + 4, 160));
    elements.push(label(qx + 16, 192, "GND"));
    return {
      elements,
      gt: {
        components: [
          { ref: `R${r1}`, symbol: "resistor" },
          { ref: `R${r2}`, symbol: "resistor" },
          { ref: `Q${q}`, symbol: "transistor_bjt" },
        ],
        nets: [
          { name: "VIN", connectedRefs: [`R${r1}.1`] },
          { name: "N1", connectedRefs: [`R${r1}.2`, `Q${q}.1`] },
          { name: "N2", connectedRefs: [`R${r2}.2`, `Q${q}.2`] },
          { name: "VCC", connectedRefs: [`R${r2}.1`] },
          { name: "GND", connectedRefs: [`Q${q}.3`] },
        ],
      },
    };
  },
};

const TEMPLATES: Template[] = [POWER_LED_TEMPLATE, RC_FILTER_TEMPLATE, OPAMP_TEMPLATE, TRANSISTOR_SWITCH_TEMPLATE];

/**
 * 生成合成电学附图（SVG → PNG 写入 figures 目录），返回 manifest 条目。
 *
 * @param count 生成数量（模板轮换 + 标号偏移，内容互不相同）
 */
export async function generateSyntheticFigures(count: number): Promise<SyntheticBenchmarkFigure[]> {
  await mkdir(SYNTH_FIGURES_DIR, { recursive: true });
  // 惰性加载 sharp（脚本运行环境），避免模块顶层依赖
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;

  const figures: SyntheticBenchmarkFigure[] = [];
  for (let i = 0; i < count; i++) {
    const template = TEMPLATES[i % TEMPLATES.length]!;
    const offset = Math.floor(i / TEMPLATES.length) * 10;
    const { elements, gt } = template.draw(offset);
    const imageFile = `synth-${template.id}-${i}.png`;

    const svgText = svg(template.width, template.height, elements);
    const pngBuffer = await sharp(Buffer.from(svgText)).png().toBuffer();
    await writeFile(path.join(SYNTH_FIGURES_DIR, imageFile), pngBuffer);

    figures.push({
      id: `synth-${template.id}-${i}`,
      imageFile,
      sourceCase: "合成基准（标准符号）",
      sourceFile: "scripts/figure-benchmark/synth.ts",
      figureNumber: 1,
      title: template.title,
      humanFigureType: template.figureType,
      expectedRefNumbers: gt.components.map(c => c.ref),
      keyComponents: gt.components.map(c => ({ refNumber: c.ref, name: c.symbol })),
      expectedElectrical: gt,
      notes: `模板 ${template.id}（offset ${offset}）`,
    });
  }
  return figures;
}
