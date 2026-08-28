/**
 * src/patent/figuregen — Graphviz 可选渲染器（复杂大图增强）。
 *
 * buildFigureDot 产出的 DOT 经本机 `dot -Tsvg` 渲染后，做三件事再交付：
 * 1. 剥离 XML 声明/DOCTYPE/含版本号的生成器注释（交付物干净且不含本机指纹）；
 * 2. 颜色关键字归一化为十六进制，并做黑白不变式扫描（非黑白 fail-closed，
 *    与 render-svg 构造期不变式同一条 4.3/4.6 底线）；
 * 3. 按节点 id 向 graphviz 节点分组 `<g>` 注入 data-ref 属性（找不到 title
 *    即抛错，绝不静默交付无标记 SVG）；最后用 readback 回读自检 ref 全数还原。
 *
 * dot 二进制定位：SATI_GRAPHVIZ_DOT 显式路径优先，否则扫 PATH。graphviz 为
 * 可选系统依赖（决策记录 2026-08-28：不加重桌面分发），缺失由调用方
 * fail-closed 报错，不做静默回退。渲染选择经 SATI_FIGURE_RENDERER 环境变量
 * （工具层读取）；不选 schema 选项是因为 llm-replay 请求键绑定工具 inputSchema。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildFigureDot, dotNodeTitle } from "./dot.js";
import { parseFigureSvg } from "./readback.js";
import type { FigureSpec, Jurisdiction } from "./types.js";

/** 渲染器选择环境变量：`builtin`（默认）| `graphviz`。 */
export const FIGURE_RENDERER_ENV = "SATI_FIGURE_RENDERER";
/** dot 可执行文件显式路径（优先于 PATH 查找）。 */
export const GRAPHVIZ_DOT_ENV = "SATI_GRAPHVIZ_DOT";

const DEFAULT_DOT_TIMEOUT_MS = 30_000;

/** 定位 dot 可执行文件：SATI_GRAPHVIZ_DOT 优先，其次 PATH 扫描；找不到返回 null。 */
export function resolveDotBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[GRAPHVIZ_DOT_ENV];
  if (override !== undefined && override.trim() !== "") {
    return override.trim();
  }
  const searchPath = env.PATH ?? env.Path ?? "";
  const executable = process.platform === "win32" ? "dot.exe" : "dot";
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

type DotRunResult = { stdout: string; stderr: string };

/** dot -Tsvg：DOT 源走 stdin，SVG 走 stdout。非零退出/超时/启动失败均带 stderr 报错。 */
function runDot(dotPath: string, source: string, timeoutMs: number): Promise<DotRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(dotPath, ["-Tsvg"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    // dot 启动失败/早退时 stdin 可能 EPIPE：吞掉，真实错误由 error/close 事件携带
    child.stdin.on("error", () => {});
    child.on("error", err => {
      clearTimeout(timer);
      reject(new Error(`无法执行 graphviz dot（${dotPath}）: ${err.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`graphviz dot 渲染超时（${timeoutMs}ms）`));
        return;
      }
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`graphviz dot 退出码 ${code}: ${stderrText.slice(0, 500) || "(无 stderr)"}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderrText });
    });
    child.stdin.end(source, "utf8");
  });
}

/** 颜色关键字 → 十六进制（dot 会把 bgcolor 等按原样输出为关键字色名）。 */
function normalizeColors(svg: string): string {
  return svg.replaceAll(
    /\b(fill|stroke|color)="(black|white)"/giu,
    (_match, attr: string, name: string) => `${attr}="${name.toLowerCase() === "black" ? "#000000" : "#FFFFFF"}"`,
  );
}

/** 黑白不变式：所有 fill/stroke/color 取值仅允许 none/#000000/#FFFFFF。 */
function assertBlackWhite(svg: string): void {
  const colorAttr = /\b(fill|stroke|color)="([^"]*)"/gu;
  for (const match of svg.matchAll(colorAttr)) {
    const value = match[2].trim().toLowerCase();
    if (value === "none" || value === "#000000" || value === "#ffffff") continue;
    throw new Error(`graphviz 渲染出现非黑白颜色 "${match[2]}"（审查指南一部一章 4.3/4.6，fail-closed）`);
  }
  for (const match of svg.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)) {
    const hex = match[0].toUpperCase();
    if (hex !== "#000000" && hex !== "#FFFFFF") {
      throw new Error(`graphviz 渲染出现非黑白颜色 ${hex}（审查指南一部一章 4.3/4.6，fail-closed）`);
    }
  }
}

/** 解析根 <svg> 的 viewBox（dot 以 pt 计），得到画幅宽高。 */
function parseCanvasSize(svg: string): { width: number; height: number } {
  const match = svg.match(/viewBox="[\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/u);
  if (!match) {
    throw new Error("graphviz SVG 缺少 viewBox，无法确定画幅");
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * 把 dot 的原始 SVG 加工为 figuregen 交付契约：剥离头部（XML 声明/DOCTYPE/
 * 生成器注释）、归一化颜色并做黑白扫描、向节点分组注入 data-ref。
 */
export function postProcessGraphvizSvg(rawSvg: string, refsById: ReadonlyMap<string, number>): string {
  const svgStart = rawSvg.indexOf("<svg");
  if (svgStart === -1) {
    throw new Error("graphviz 输出不含 <svg> 元素");
  }
  let svg = normalizeColors(rawSvg.slice(svgStart));
  assertBlackWhite(svg);

  for (const [nodeId, ref] of refsById) {
    const titleTag = `<title>${dotNodeTitle(nodeId)}</title>`;
    const titleIdx = svg.indexOf(titleTag);
    if (titleIdx === -1) {
      throw new Error(`graphviz SVG 未找到节点「${nodeId}」的 title，无法注入 data-ref（fail-closed）`);
    }
    const groupIdx = svg.lastIndexOf("<g ", titleIdx);
    if (groupIdx === -1) {
      throw new Error(`graphviz SVG 节点「${nodeId}」的 title 外无 <g> 分组，无法注入 data-ref（fail-closed）`);
    }
    const tagEnd = svg.indexOf(">", groupIdx);
    if (tagEnd === -1 || tagEnd > titleIdx) {
      throw new Error(`graphviz SVG 节点「${nodeId}」的分组标签未闭合，无法注入 data-ref（fail-closed）`);
    }
    // title 与其所在分组开标签之间不得再有任何标签：确认找到的 <g> 就是
    // <title> 的直接父分组（graphviz 输出中 title 恒为节点分组首子元素）。
    const between = svg.slice(tagEnd + 1, titleIdx);
    if (between.includes("<g") || between.includes("</g>")) {
      throw new Error(`graphviz SVG 节点「${nodeId}」的分组结构异常，无法注入 data-ref（fail-closed）`);
    }
    svg = `${svg.slice(0, tagEnd)} data-ref="${ref}"${svg.slice(tagEnd)}`;
  }
  return svg;
}

export type GraphvizRenderOptions = {
  /** dot 可执行文件路径；缺省走 resolveDotBinary()。 */
  dotPath?: string;
  jurisdiction?: Jurisdiction;
  /** dot 进程超时（毫秒），默认 30s。 */
  timeoutMs?: number;
};

/**
 * Graphviz 渲染单幅附图：DOT 生成 → dot -Tsvg → 加工 → readback 自检
 * （figure_no 与全部 data-ref 必须可回读还原，否则抛错）。
 */
export async function renderFigureSvgWithGraphviz(
  spec: FigureSpec,
  options: GraphvizRenderOptions = {},
): Promise<{ svg: string; width: number; height: number }> {
  const dotPath = options.dotPath ?? resolveDotBinary();
  if (dotPath === null) {
    throw new Error(`未找到 graphviz dot 可执行文件：请安装 graphviz，或用 ${GRAPHVIZ_DOT_ENV} 指定路径`);
  }
  const { stdout } = await runDot(
    dotPath,
    buildFigureDot(spec, { jurisdiction: options.jurisdiction }),
    options.timeoutMs ?? DEFAULT_DOT_TIMEOUT_MS,
  );
  const refsById = new Map<string, number>();
  for (const node of spec.nodes) {
    if (node.ref !== undefined) {
      refsById.set(node.id, node.ref);
    }
  }
  const svg = postProcessGraphvizSvg(stdout, refsById);

  const parsed = parseFigureSvg(svg);
  if (parsed.figureNo !== spec.figure_no) {
    throw new Error(`graphviz 渲染自检失败：回读图号 ${parsed.figureNo} ≠ 期望 ${spec.figure_no}`);
  }
  const expectedRefs = [...refsById.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const parsedRefs = parsed.nodes
    .filter(node => node.ref !== undefined)
    .map(node => [node.id, node.ref] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(parsedRefs) !== JSON.stringify(expectedRefs)) {
    throw new Error("graphviz 渲染自检失败：data-ref 回读与 FigureSpec 不一致");
  }

  const { width, height } = parseCanvasSize(svg);
  return { svg, width, height };
}
