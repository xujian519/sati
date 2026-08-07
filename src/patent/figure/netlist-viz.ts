/**
 * 电学网表可视化（P2-3）。
 *
 * 把 ElectricalAnalysis 渲染为可直接嵌入文档的 Mermaid 流程图，
 * 或生成简单 SVG。用于审查、报告与附图说明增强。
 */

import type { ElectricalAnalysis } from "./types.js";

/** Mermaid 节点 ID 合法化（保留字母/数字/下划线，其它替换为下划线）。 */
export function mermaidId(ref: string): string {
  return `n_${ref.replace(/[^a-zA-Z0-9_]/gu, "_")}`;
}

/** 转义 Mermaid 节点显示文本中的引号与括号。 */
function mermaidLabel(text: string): string {
  return text.replace(/"/gu, "#quot;");
}

/**
 * 生成 Mermaid flowchart LR。
 *
 * 每个元件与每个网络均为节点；元件用矩形框，网络用圆形节点，
 * 电源/地用特殊样式类。边不带箭头（电气连接是双向的）。
 */
export function renderElectricalNetlistMermaid(analysis: ElectricalAnalysis): string {
  if (analysis.components.length === 0) return "flowchart LR\n  空电路图[无元件]";

  const lines: string[] = ["flowchart LR"];
  const { components, nets } = analysis;

  // 元件节点
  for (const c of components) {
    const label = `${c.ref}\\n${c.name}${c.value ? `\\n${c.value}` : ""}`;
    lines.push(`  ${mermaidId(c.ref)}["${mermaidLabel(label)}"]`);
  }

  // 网络节点与连接
  for (const net of nets) {
    const netId = mermaidId(net.name);
    const netLabel = mermaidLabel(net.name);
    const isPower = isPowerNet(net.name);
    lines.push(`  ${netId}(("${netLabel}"))`);
    if (isPower) lines.push(`  class ${netId} powerNet;`);

    for (const conn of net.connectedRefs) {
      const [ref] = parseConnectedRef(conn);
      if (!ref) continue;
      lines.push(`  ${mermaidId(ref)} --- ${netId}`);
    }
  }

  // 未出现在任何 net 的孤立元件也保留（与 validator 一致）
  const connectedRefs = new Set(nets.flatMap(n => n.connectedRefs.map(r => parseConnectedRef(r)[0])).filter(Boolean));
  for (const c of components) {
    if (!connectedRefs.has(c.ref)) {
      lines.push(`  ${mermaidId(c.ref)} -. 孤立 .-> ${mermaidId("GND_")}`);
    }
  }

  lines.push("  classDef powerNet fill:#f9f,stroke:#333,stroke-width:2px;");
  return lines.join("\n");
}

/** 判断是否为电源/地网络名。 */
function isPowerNet(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper === "GND" ||
    upper === "VCC" ||
    upper === "VDD" ||
    upper === "VEE" ||
    upper.startsWith("VCC") ||
    upper.startsWith("VDD")
  );
}

/** 解析 connectedRefs 条目 "R1.1" → ["R1", "1"]。 */
function parseConnectedRef(conn: string): [string, string] {
  const idx = conn.lastIndexOf(".");
  if (idx < 0) return [conn, ""];
  return [conn.slice(0, idx), conn.slice(idx + 1)];
}

/** 生成纯文本摘要（用于不能渲染图表的场景）。 */
export function formatElectricalSummary(analysis: ElectricalAnalysis): string {
  const lines: string[] = [];
  lines.push(`元件数量：${analysis.components.length}，网络数量：${analysis.nets.length}`);
  if (analysis.components.length > 0) {
    lines.push("\n元件清单：");
    for (const c of analysis.components) {
      const value = c.value ? `，参数 ${c.value}` : "";
      const pins = c.terminalCount ? `，${c.terminalCount} 引脚` : "";
      lines.push(`- ${c.ref}：${c.name}（${c.category}${value}${pins}）`);
    }
  }
  if (analysis.nets.length > 0) {
    lines.push("\n网络清单：");
    for (const n of analysis.nets) {
      lines.push(`- ${n.name}：${n.connectedRefs.join(", ")}`);
    }
  }
  if (analysis.netlist) {
    lines.push("\n网表（SPICE 风格）：\n```\n" + analysis.netlist.trim() + "\n```");
  }
  return lines.join("\n");
}

/**
 * 生成简单 SVG 电路图（固定网格布局，适合快速预览）。
 *
 * 布局策略：把元件按列排列，网络画为竖直线/水平线连接相邻元件；
 * 复杂拓扑会简化，主要用于验证 netlist 结构而非出版级绘图。
 */
export function renderElectricalNetlistSvg(analysis: ElectricalAnalysis): string {
  const { components, nets } = analysis;
  if (components.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><text x="10" y="35">无元件</text></svg>`;
  }

  const colWidth = 120;
  const rowHeight = 80;
  const cols = Math.max(1, Math.ceil(Math.sqrt(components.length)));
  const rows = Math.ceil(components.length / cols);
  const width = cols * colWidth + 40;
  const height = rows * rowHeight + 80;

  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < components.length; i += 1) {
    const c = components[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(c.ref, { x: col * colWidth + 30, y: row * rowHeight + 40 });
  }

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
  ];

  // 绘制网络连线（同一网络元件之间连一条折线）
  for (const net of nets) {
    const refs = net.connectedRefs.map(r => parseConnectedRef(r)[0]).filter(Boolean);
    const points = refs.map(r => positions.get(r)).filter((p): p is { x: number; y: number } => p !== undefined);
    if (points.length < 2) continue;
    const d = points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const color = isPowerNet(net.name) ? "#c00" : "#333";
    svgParts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    svgParts.push(
      `<text x="${points[0].x}" y="${points[0].y - 8}" font-size="11" fill="${color}">${escapeXml(net.name)}</text>`,
    );
  }

  // 绘制元件节点
  for (const c of components) {
    const p = positions.get(c.ref);
    if (!p) continue;
    const w = 80;
    const h = 40;
    svgParts.push(
      `<rect x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" fill="#f5f5f5" stroke="#333" stroke-width="1.5"/>`,
    );
    svgParts.push(
      `<text x="${p.x}" y="${p.y - 4}" text-anchor="middle" font-size="12" fill="#000">${escapeXml(c.ref)}</text>`,
    );
    svgParts.push(
      `<text x="${p.x}" y="${p.y + 12}" text-anchor="middle" font-size="10" fill="#555">${escapeXml(c.name)}</text>`,
    );
  }

  svgParts.push("</svg>");
  return svgParts.join("\n");
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
