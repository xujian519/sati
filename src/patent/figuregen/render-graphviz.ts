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
 *
 * 渲染后端经 DotRunner 接缝可替换：本模块默认给子进程 runner（`dot -Tsvg`），
 * WASM runner 在 render-viz-wasm.ts（无系统 graphviz 的机器走同一套加工链）。
 * 加工链（剥离头部/黑白扫描/data-ref 注入/回读自检）对两种后端逐字节同一份代码。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildFigureDot } from "./dot.js";
import { parseFigureSvg, unescapeXml, withFigureNumberAttribute } from "./readback.js";
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

/**
 * DOT 渲染后端：吃 DOT 源、吐 SVG 文本。唯一契约是"输入 DOT 字符串、输出 SVG 文本"，
 * 加工链（postProcessGraphvizSvg）对子进程与 WASM 两种后端完全一致。
 */
export type DotRunner = (dot: string, signal?: AbortSignal) => Promise<string>;

type DotRunResult = { stdout: string; stderr: string };

/** dot -Tsvg：DOT 源走 stdin，SVG 走 stdout。非零退出/超时/启动失败/取消均带 stderr 报错。 */
function runDot(dotPath: string, source: string, timeoutMs: number, signal?: AbortSignal): Promise<DotRunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("graphviz dot 渲染已取消（signal 已 abort）"));
      return;
    }
    const child = spawn(dotPath, ["-Tsvg"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const detach = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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
      detach();
      reject(new Error(`无法执行 graphviz dot（${dotPath}）: ${err.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      detach();
      if (aborted) {
        reject(new Error("graphviz dot 渲染已取消（signal 已 abort）"));
        return;
      }
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

/** 构造子进程 dot 后端（`dot -Tsvg`，DOT 走 stdin、SVG 走 stdout、超时默认 30s）。 */
export function createSubprocessDotRunner(dotPath: string, timeoutMs: number = DEFAULT_DOT_TIMEOUT_MS): DotRunner {
  return async (dot, signal) => {
    const { stdout } = await runDot(dotPath, dot, timeoutMs, signal);
    return stdout;
  };
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
 * 定位节点分组开标签的 `>` 位置：扫 `class="node"` 分组，取其**首个子元素** `<title>`、
 * 反转义后与节点 id 比对。
 *
 * 不能拿"未转义的 title 字符串"去 `indexOf`：graphviz 会把 `-` 写成 `&#45;`
 * （`<title>f1&#45;n1</title>`），而节点 id 用连字符是常规形态（`f1-n1`）——按字面量
 * 匹配会让整条 graphviz 通路对这类 id 一律 fail-closed。要求 title 是首个子元素，
 * 同时挡住"读到嵌套分组的 title"。
 */
function findNodeGroupTagEnd(svg: string, nodeId: string): number | undefined {
  for (const match of svg.matchAll(/<g\b([^>]*)>/gu)) {
    if (!/\bclass="node"/u.test(match[1]!)) {
      continue;
    }
    const tagEnd = (match.index ?? 0) + match[0].length - 1;
    const groupEnd = svg.indexOf("</g>", tagEnd);
    if (groupEnd === -1) {
      continue;
    }
    const titleMatch = svg.slice(tagEnd + 1, groupEnd).match(/^\s*<title>([\s\S]*?)<\/title>/u);
    if (titleMatch !== null && unescapeXml(titleMatch[1]!) === nodeId) {
      return tagEnd;
    }
  }
  return undefined;
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
    const tagEnd = findNodeGroupTagEnd(svg, nodeId);
    if (tagEnd === undefined) {
      throw new Error(`graphviz SVG 未找到节点「${nodeId}」的 title（分组内首个子元素，解码后比对；fail-closed）`);
    }
    svg = `${svg.slice(0, tagEnd)} data-ref="${ref}"${svg.slice(tagEnd)}`;
  }
  return svg;
}

export type GraphvizRenderOptions = {
  /** DOT 渲染后端；提供时不再要求/使用 dot 二进制（WASM 后端走这里）。 */
  runner?: DotRunner;
  /** dot 可执行文件路径；缺省走 resolveDotBinary()。仅在未提供 runner 时使用。 */
  dotPath?: string;
  jurisdiction?: Jurisdiction;
  /** 本案附图总幅数（图号是否需要标注由图幅数与法域档案共同决定；缺省 1）。 */
  figureCount?: number;
  /** dot 进程超时（毫秒），默认 30s。仅在未提供 runner 时使用。 */
  timeoutMs?: number;
};

/**
 * Graphviz 渲染单幅附图：DOT 生成 → 后端渲染（子进程 dot 或 WASM）→ 加工 →
 * readback 自检（figure_no 与全部 data-ref 必须可回读还原，否则抛错）。
 */
export async function renderFigureSvgWithGraphviz(
  spec: FigureSpec,
  options: GraphvizRenderOptions = {},
): Promise<{ svg: string; width: number; height: number }> {
  let runner = options.runner;
  if (runner === undefined) {
    const dotPath = options.dotPath ?? resolveDotBinary();
    if (dotPath === null) {
      throw new Error(`未找到 graphviz dot 可执行文件：请安装 graphviz，或用 ${GRAPHVIZ_DOT_ENV} 指定路径`);
    }
    runner = createSubprocessDotRunner(dotPath, options.timeoutMs);
  }
  const rawSvg = await runner(
    buildFigureDot(spec, { jurisdiction: options.jurisdiction, figureCount: options.figureCount ?? 1 }),
  );
  const refsById = new Map<string, number>();
  for (const node of spec.nodes) {
    if (node.ref !== undefined) {
      refsById.set(node.id, node.ref);
    }
  }
  // 图号条件化后，可见标注可能不存在（单幅在 PCT/US 不得出现 "Fig."），故把机器可读的
  // 图号写进根元素属性，与内置渲染器同一契约（readback 优先读它）。
  const svg = withFigureNumberAttribute(postProcessGraphvizSvg(rawSvg, refsById), spec.figure_no);

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
