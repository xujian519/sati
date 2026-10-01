/**
 * src/patent/figuregen — Inkscape「文字转路径」独立导出（字体无关交付）。
 *
 * **为什么需要**：本模块产出的附图 SVG 不声明可用字体（根元素至多写死 `font-family="sans-serif"`），
 * 图形里的 `<text>` 由**读者**环境挑字体渲染——印厂、审查端查看器、同事笔记本缺 CJK 字体时文字变
 * 豆腐块或字宽错位，而这是**交付物层面**的缺陷：本仓所有流程门禁都检测不到（不报错、能打开、就是
 * 读不出）。开启本步骤后，字形被 Inkscape 换成轮廓路径，字与画一起走矢量，任何渲染器都一样。
 *
 * **代价（如实声明）**：
 * - 引入外部 **GPL** 二进制 Inkscape（安装包约 **645MB**），故本步骤**默认关**（`SATI_FIGURE_TEXT_TO_PATH`），
 *   没装 Inkscape 的部署仍必须能出图；
 * - 每图约 **0.4s**（参照 DSH 实测，同量级）；
 * - 文件体积约 **10 倍**（轮廓路径替代 `<text>`）；
 * - 文字**不再可搜索、不可就地编辑**（印发前的文案修改必须回到生成侧重跑）。
 *
 * **必须验产物，不能只看退出码**（DSH 实测教训，Inkscape 1.4.4）：个别中文字形会让 Inkscape 写出
 * **截断的 PDF 且退出码为 0**。同族风险在 SVG 侧表现为"提前退出、产物是半成品或原样带 `<text>`"，
 * 故本模块**一律以产物为准**：安全门 + 无残留 `<text>` + 几何/尺寸守卫三条全过才写回，退出码只用于
 * 失败归类。同理，退出码为 0 但 stderr 有实质输出也判失败（见 `classifyInkscapeRun`）。
 *
 * **原子换入的具体步骤**（被拒时**原文件逐字节不变**）：
 * 1. 读原文件 → 2. 转出到**临时目录**（Inkscape 不改写输入，就地改写只由本模块做）→
 * 3. 产物过三条校验 → 4. 写**同目录**临时文件 → 5. `rename` 覆盖原路径（同文件系统，读取方看到的
 * 要么是原图、要么是完整产物；rename 失败即清理临时文件）。
 *
 * **几何守卫是近似实现**（本模块自带最小实现，**不导入** `render-check.ts` 的 `measureInkBounds`——
 * 图文量测另有改动线在演进，本模块不为它增加编译期依赖）：根元素 viewBox/宽高的等价性是**严格**判据；
 * 墨迹包围盒则是**轻量估算**（只按几何属性取数值坐标、**不做 transform 求逆**、`<path>` 的 `d` 按数值
 * 两两成对近似解析、文本按占位框估上界）——它只用于**同一文档转换前后**的对比（Inkscape 保留变换属性，
 * 故同一套近似在两侧同构），作用是拦住"整层丢失/坐标错位/画布被改写"这类**量级远超 1mm** 的走样，
 * **不是**精确测量；判据只查**向外越界**（占位框本就是上界，轮廓向内收缩属正常）。
 *
 * 可执行发现：`SATI_INKSCAPE_CMD` 显式覆盖 → 平台候选路径 → PATH。**显式覆盖值不存在即抛 `TypeError`**
 * （与本仓 `resolveFreecadCmd` 的 fail-loud 契约一致；`resolveDotBinary` 在此处不校验，属已知漂移，
 * 本模块不复制那个行为）；入口 `exportSvgTextToPath` 把该 `TypeError` 收敛成结构化的 `setup_required`。
 *
 * 失败因归一分序：**内部超时 > 调用方取消 > spawn 失败 > 信号终止 > 退出码 > stderr 实质输出**。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readBoolEnv } from "../../shared/env/index.js";
import { DEFAULT_SVG_MAX_BYTES, assertSafeSvg, isSvgSafetyError } from "./svg-safety.js";

/** 显式指定 Inkscape 可执行文件路径的环境变量（优先于平台候选与 PATH；值不存在即抛 `TypeError`）。 */
export const INKSCAPE_CMD_ENV = "SATI_INKSCAPE_CMD";

/** 文字转路径开关的环境变量（默认**关**；只有显式开启的部署才走外部 GPL 二进制）。 */
export const FIGURE_TEXT_TO_PATH_ENV = "SATI_FIGURE_TEXT_TO_PATH";

/** 默认单次转换超时（毫秒）。 */
export const INKSCAPE_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 几何守卫的固定容差（毫米）：轮廓路径的墨迹允许比原图占位框多出这么多。
 * 字形轮廓与占位框估算的差异（全角字上缘约 0.5mm）在这个量级内，而整层丢失、坐标整体错位的
 * 差异是数十毫米量级。
 */
export const OUTLINE_GEOMETRY_SLACK_MM = 1;

/** 几何守卫的比例容差（相对墨迹跨度）：占位框估算误差随字形尺寸等比放大，固定毫米容差在大幅面页上会误报。 */
export const OUTLINE_GEOMETRY_SLACK_RATIO = 0.01;

/** 各平台 Inkscape 的常见安装位置（不存在的条目跳过；Windows 路径在 POSIX 上自然落空）。 */
export const INKSCAPE_CANDIDATE_PATHS: readonly string[] = [
  "/opt/homebrew/bin/inkscape",
  "/usr/local/bin/inkscape",
  "/usr/bin/inkscape",
  "/snap/bin/inkscape",
  "/Applications/Inkscape.app/Contents/MacOS/inkscape",
  "C:\\Program Files\\Inkscape\\bin\\inkscape.exe",
  "C:\\Program Files (x86)\\Inkscape\\bin\\inkscape.exe",
];

/** PATH 各分段里查找的文件名。 */
const INKSCAPE_BINARY_NAMES: readonly string[] = ["inkscape", "inkscape.exe"];

/**
 * 转换后的产物里出现文字元素即判失败；带命名空间前缀的写法与 `textPath` 同样算残留。
 * 注释里的示例文本不算（判前先去注释）。
 */
const TEXT_ELEMENT_PATTERN = /<(?:[\w.-]+:)?(?:text|textPath)[\s/>]/iu;

/** 注释段（判 `<text>` 残留与量测几何前都要先去掉：注释不是渲染内容）。 */
const COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

/** stderr 里与产物质量无关的环境噪声前缀（判"实质输出"时剔除；只剔除这一类已知噪声）。 */
const INKSCAPE_STDERR_NOISE_PATTERNS: readonly RegExp[] = [
  /^\s*fontconfig/i,
  /^\s*(?:gtk|gdk|glib|dbus)[-:]/i,
  /^\s*\(inkscape:\d+\):\s*(?:gtk|gdk|glib)/i,
];

/** 数值字面量（SVG 属性里的坐标/长度）。 */
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/gu;

/** CSS 无单位长度的毫米当量（SVG 里无单位即 px）。 */
const MM_PER_PX = 25.4 / 96;

/** 文本占位框：字号缺省时按 SVG/CSS 规范默认值 16 用户单位估（上界越宽，越不易误拒）。 */
const DEFAULT_ASSUMED_FONT_SIZE = 16;

/** 占位框相对基线的上/下延伸（em）：按规范般宽松取值，使原图侧恒为字形的上界。 */
const TEXT_ASCENT_EM = 1;
const TEXT_DESCENT_EM = 0.3;

/** 错误信息里 stderr/generic 文本的截断长度。 */
const MESSAGE_EXCERPT_MAX = 500;

/** 可执行发现结果（路径 + 来源，供报告与诊断）。 */
export type InkscapeProbe = {
  /** 可用的 Inkscape 可执行文件路径。 */
  cmd: string;
  /** 来源（环境变量 / 平台候选 / PATH 分段），供报告与诊断。 */
  source: string;
};

/**
 * 定位 Inkscape 可执行文件：`SATI_INKSCAPE_CMD` 显式覆盖 → 平台候选路径 → PATH 分段。
 *
 * 显式覆盖值不存在时抛 `TypeError`（**不回落**自动探测）：环境变量是部署方的显式声明，
 * 静默改用别的二进制会让"我配了但没用上"变成无声的事实。
 */
export function resolveInkscapeCmd(
  env: NodeJS.ProcessEnv = process.env,
  options: { exists?: (path: string) => boolean } = {},
): InkscapeProbe | undefined {
  const exists = options.exists ?? existsSync;
  const explicit = (env[INKSCAPE_CMD_ENV] ?? "").trim();
  if (explicit.length > 0) {
    if (!exists(explicit)) {
      throw new TypeError(`${INKSCAPE_CMD_ENV} 指向的文件不存在：${explicit}`);
    }
    return { cmd: explicit, source: INKSCAPE_CMD_ENV };
  }
  for (const candidate of INKSCAPE_CANDIDATE_PATHS) {
    if (exists(candidate)) return { cmd: candidate, source: `探测路径 ${candidate}` };
  }
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") continue;
    for (const name of INKSCAPE_BINARY_NAMES) {
      const candidate = join(dir, name);
      if (exists(candidate)) return { cmd: candidate, source: `PATH ${dir}` };
    }
  }
  return undefined;
}

/**
 * 读取文字转路径开关（`SATI_FIGURE_TEXT_TO_PATH`，`1`/`true`/`on` 为开，**默认关**）。
 * 门控按部署级环境变量而非工具入参：改工具 `inputSchema` 会让 llm-replay fixture 失配
 * （本仓"重放契约"铁律），故本模块**不碰任何工具的 schema**。
 */
export function isFigureTextToPathEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolEnv(env[FIGURE_TEXT_TO_PATH_ENV], false);
}

/** Inkscape 缺失/路径失效时的安装指引（`setup_required` 语义的正文）。 */
export function inkscapeInstallHint(explicit?: string): string {
  const head =
    explicit === undefined || explicit.trim() === ""
      ? "未找到 Inkscape 可执行文件。"
      : `已配置的 ${INKSCAPE_CMD_ENV} 不可用：${explicit}。`;
  return [
    head,
    "文字转路径需要系统安装 Inkscape（macOS：brew install --cask inkscape；Ubuntu/Debian：sudo apt install inkscape；",
    `Windows：winget install Inkscape.Inkscape），或用 ${INKSCAPE_CMD_ENV} 指定可执行文件路径。`,
    `该步骤是可选加固（外部 GPL 二进制约 645MB）：不需要字体无关交付时把 ${FIGURE_TEXT_TO_PATH_ENV} 关掉即可。`,
  ].join("");
}

/** 子进程运行事实（注入式 runner 的返回契约；分类只看这些字段，不看别的）。 */
export type InkscapeRunFacts = {
  /** 被调用的可执行文件（写进错误信息）。 */
  cmd: string;
  /** spawn 自身失败（可执行不存在/权限不足）时的错误消息；成功启动时为 undefined。 */
  spawnError: string | undefined;
  /** 内部超时是否触发（触发时子进程已被强杀）。 */
  timedOut: boolean;
  /** 调用方取消是否触发（触发时子进程已被强杀）。 */
  cancelled: boolean;
  /** 退出码；被信号终止且无退出码时为 null。 */
  exitCode: number | null;
  /** 终止信号名；正常退出为 null。 */
  signal: string | null;
  stdout: string;
  stderr: string;
};

/**
 * 进程运行器契约（注入点：单测既可用假可执行文件走真实 spawn，也可注入替身覆盖极端时序）。
 * argv 直传、不经 shell；`cwd` 固定为本次转换的临时目录。
 */
export type InkscapeRunner = (
  cmd: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<InkscapeRunFacts>;

/**
 * 默认运行器：`spawn` + 内部期限 + 调用方取消（与 `render-graphviz.ts` 的 runDot 同构）。
 * 期限自 spawn 起算；超时/取消都强杀子进程，再由 `classifyInkscapeRun` 按固定分序归类。
 */
export const defaultInkscapeRunner: InkscapeRunner = (cmd, args, options) =>
  new Promise<InkscapeRunFacts>(resolve => {
    if (options.signal?.aborted === true) {
      // 已取消就不再起进程：省掉一次必然失败的 spawn，也让分类退化成纯粹的"被调用方取消"。
      resolve({
        cmd,
        spawnError: undefined,
        timedOut: false,
        cancelled: true,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
      });
      return;
    }
    const child = spawn(cmd, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;
    const onAbort = (): void => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    const detach = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const settle = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      resolve({
        cmd,
        spawnError,
        timedOut,
        cancelled,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    // spawn 失败（ENOENT 等）先来 error 再来 close：以先到者为准，避免重复 resolve。
    child.on("error", err => {
      spawnError = err.message;
      settle(null, null);
    });
    child.on("close", (code, signal) => {
      settle(code, signal);
    });
  });

/** 失败归类结果（code 粗粒度、reason 细粒度，`error` 面向用户、含 stderr 摘录）。 */
export type SvgTextToPathFailure = {
  code: SvgTextToPathErrorCode;
  reason: SvgTextToPathFailureReason;
  error: string;
};

/** 结构化错误码（粗粒度；细粒度见 {@link SvgTextToPathFailureReason}）。 */
export type SvgTextToPathErrorCode = "setup_required" | "unsupported_target" | "render_failed" | "cancelled";

/** 结构化失败原因（可区分，供调用方分支与报告）。 */
export type SvgTextToPathFailureReason =
  /** 目标不是 SVG（png/pdf 等）：本步骤不生效。 */
  | "not_applicable"
  /** 平台候选与 PATH 均未找到 Inkscape。 */
  | "not_installed"
  /** `SATI_INKSCAPE_CMD` 指向不存在的文件（fail-loud 的显式声明落空）。 */
  | "invalid_cmd"
  /** 临时目录创建失败（本模块内部故障）。 */
  | "internal_failed"
  /** 读取原文件或产物失败。 */
  | "read_failed"
  /** 子进程无法启动（可执行不存在/不可执行）。 */
  | "spawn_failed"
  /** 内部期限到期（子进程已强杀）。 */
  | "timeout"
  /** 调用方取消（子进程已强杀）。 */
  | "cancelled"
  /** 被信号终止（非内部超时、非调用方取消）。 */
  | "signalled"
  /** 非零退出码。 */
  | "exit_code"
  /** 退出码为 0 但 stderr 有实质输出（退出码不是成功的充分条件）。 */
  | "stderr_output"
  /** Inkscape 未生成输出文件或产物为空。 */
  | "missing_product"
  /** 产物未过 SVG 安全门（DOCTYPE/ENTITY/CDATA/超限）。 */
  | "unsafe_product"
  /** 产物仍含 `<text>`：文字没转成路径，字体依赖的承诺不成立。 */
  | "text_remains"
  /** 产物几何/画布走样（守卫拒收）。 */
  | "geometry_regression"
  /** 原子写回失败（原文件保持不变）。 */
  | "write_failed";

/** stderr 里的实质输出（剔除已知环境噪声行；空串表示"无实质输出"）。 */
export function substantiveStderr(stderr: string): string {
  return stderr
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !INKSCAPE_STDERR_NOISE_PATTERNS.some(pattern => pattern.test(line)))
    .join(" | ");
}

/**
 * 按固定分序归类子进程失败：**内部超时 > 调用方取消 > spawn 失败 > 信号终止 > 退出码 > stderr 实质输出**。
 * 全部不命中返回 undefined（成功；此时仍由产物校验决定是否放行）。
 */
export function classifyInkscapeRun(facts: InkscapeRunFacts, timeoutMs: number): SvgTextToPathFailure | undefined {
  const excerpt = substantiveStderr(facts.stderr);
  const tail = excerpt.length > 0 ? `：${truncate(excerpt)}` : "";
  if (facts.timedOut) {
    return {
      code: "render_failed",
      reason: "timeout",
      error: `Inkscape 文字转路径超时（${timeoutMs}ms，已强杀子进程）${tail}`,
    };
  }
  if (facts.cancelled) {
    return { code: "cancelled", reason: "cancelled", error: `Inkscape 文字转路径被调用方取消${tail}` };
  }
  if (facts.spawnError !== undefined) {
    return {
      code: "render_failed",
      reason: "spawn_failed",
      error: `无法启动 Inkscape（${facts.cmd}）：${truncate(facts.spawnError)}${tail}`,
    };
  }
  if (facts.exitCode === null) {
    return {
      code: "render_failed",
      reason: "signalled",
      error: `Inkscape 被信号 ${facts.signal ?? "未知"} 终止${tail}`,
    };
  }
  if (facts.exitCode !== 0) {
    return { code: "render_failed", reason: "exit_code", error: `Inkscape 退出码 ${facts.exitCode}${tail}` };
  }
  if (excerpt.length > 0) {
    // 退出码 0 **不是**成功的充分条件（Inkscape 1.4.4 实测有截断产物仍返回 0 的行为）⇒ 保守判失败。
    return {
      code: "render_failed",
      reason: "stderr_output",
      error: `Inkscape 退出码 0 但 stderr 有实质输出（可能是提前退出/半成品）${tail}`,
    };
  }
  return undefined;
}

/** 转换请求。 */
export type SvgTextToPathInput = {
  /** 待转换的 SVG 文件路径（转换成功后原地原子替换；仅 `.svg` 生效）。 */
  path: string;
  /** Inkscape 可执行路径；缺省走 `resolveInkscapeCmd(env)`。 */
  cmd?: string;
  /** 单次转换超时（毫秒），默认 {@link INKSCAPE_DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
  /** 解析可执行文件用的环境，默认 `process.env`（单测可注入，避免依赖宿主环境）。 */
  env?: NodeJS.ProcessEnv;
  /** 可执行存在性判定注入点（透传给 `resolveInkscapeCmd`）：单测用它隔离"宿主是否装了 Inkscape"。 */
  exists?: (path: string) => boolean;
  /** 注入点：单测可传替身；缺省为真实 `spawn` 运行器。 */
  runner?: InkscapeRunner;
};

/** 转换结果：成功（已原子换入），或按码/因分类的结构化失败。 */
export type SvgTextToPathOutcome =
  | {
      ok: true;
      /** 被替换的文件路径。 */
      path: string;
      /** 替换前字节数。 */
      bytesBefore: number;
      /** 替换后字节数（轮廓替代文字后通常约 10 倍）。 */
      bytesAfter: number;
    }
  | {
      ok: false;
      code: SvgTextToPathErrorCode;
      reason: SvgTextToPathFailureReason;
      /** 面向用户的失败说明（含退出码/stderr 摘录）。 */
      error: string;
      /** 缺失二进制时的安装指引（仅 `setup_required` 携带）。 */
      installHint?: string;
      /** stderr 实质输出摘录（仅子进程类失败携带）。 */
      stderr?: string;
    };

/** 轻量墨迹包围盒（用户单位；只用于同一文档转换前后的对比，见文件头注）。 */
type InkBounds = { minX: number; minY: number; maxX: number; maxY: number };

/** 根元素画幅声明。 */
type CanvasInfo = {
  viewBox: readonly [number, number, number, number] | undefined;
  widthMm: number | undefined;
  heightMm: number | undefined;
};

/**
 * 用 Inkscape 把 SVG 里的文字转成轮廓路径，产物校验通过后**原子换入原路径**。
 *
 * 命令固定为 `--export-type=svg --export-plain-svg --export-text-to-path`：纯 SVG 导出去掉
 * Inkscape 专有属性，文字转路径去掉字体依赖；画布尺寸、坐标与线宽原样保留。
 * 任一环节失败或任一条校验不通过，**原文件逐字节不变**。
 */
export async function exportSvgTextToPath(input: SvgTextToPathInput): Promise<SvgTextToPathOutcome> {
  if (!isSvgTarget(input.path)) {
    return {
      ok: false,
      code: "unsupported_target",
      reason: "not_applicable",
      error:
        `文字转路径未生效：目标不是 SVG（${input.path}）。png/pdf 的字形由导出时的渲染器决定，` +
        "本步骤只把 SVG 里的 <text> 换成轮廓路径，故对这类交付物不生效（这是显式说明，不是静默跳过）。",
    };
  }
  const env = input.env ?? process.env;
  const explicit = (input.cmd ?? "").trim();
  let cmd = explicit;
  if (cmd.length === 0) {
    let probe: InkscapeProbe | undefined;
    try {
      probe = input.exists === undefined ? resolveInkscapeCmd(env) : resolveInkscapeCmd(env, { exists: input.exists });
    } catch (error) {
      // 显式覆盖值不存在：resolveInkscapeCmd 按 fail-loud 契约抛 TypeError（同 resolveFreecadCmd）。
      // 入口把它收敛成结构化结果，使调用方无需 try/catch 也能拿到安装指引。
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: "setup_required",
        reason: "invalid_cmd",
        error: message,
        installHint: inkscapeInstallHint(input.cmd),
      };
    }
    if (probe === undefined) {
      return {
        ok: false,
        code: "setup_required",
        reason: "not_installed",
        error:
          `未找到 Inkscape 可执行文件（${INKSCAPE_CMD_ENV} 未设、平台候选路径与 PATH 均无）。` +
          "文字转路径是可选加固：不需要字体无关交付时把 " +
          FIGURE_TEXT_TO_PATH_ENV +
          " 关掉即可。",
        installHint: inkscapeInstallHint(undefined),
      };
    }
    cmd = probe.cmd;
  }

  let original: string;
  try {
    original = await readFile(input.path, "utf8");
  } catch (error) {
    return failure("render_failed", "read_failed", `读取待转换的 SVG 失败（${input.path}）：${describe(error)}`);
  }

  const runner = input.runner ?? defaultInkscapeRunner;
  const timeoutMs = input.timeoutMs ?? INKSCAPE_DEFAULT_TIMEOUT_MS;
  let workDir: string | undefined;
  try {
    try {
      workDir = await mkdtemp(join(tmpdir(), "sati-outline-"));
    } catch (error) {
      return failure("render_failed", "internal_failed", `创建转换临时目录失败：${describe(error)}`);
    }
    // 产物只写临时目录：Inkscape 不改写输入文件，就地改写由本模块在校验后一步完成。
    const productPath = join(workDir, "outlined.svg");
    const args = [
      "--export-type=svg",
      "--export-plain-svg",
      "--export-text-to-path",
      `--export-filename=${productPath}`,
      input.path,
    ];
    const facts = await runner(cmd, args, {
      cwd: workDir,
      timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const failed = classifyInkscapeRun(facts, timeoutMs);
    if (failed !== undefined) {
      const excerpt = substantiveStderr(facts.stderr);
      return { ok: false, ...failed, ...(excerpt.length > 0 ? { stderr: excerpt } : {}) };
    }
    if (!existsSync(productPath)) {
      // 退出码 0 且无 stderr，但产物不存在：Inkscape 版本差异下的静默不产出，必须报错。
      return failure("render_failed", "missing_product", `Inkscape 未生成输出文件：${productPath}`);
    }
    let product: string;
    try {
      product = await readFile(productPath, "utf8");
    } catch (error) {
      return failure("render_failed", "read_failed", `读取 Inkscape 转换产物失败：${describe(error)}`);
    }
    if (product.trim() === "") {
      return failure("render_failed", "missing_product", `Inkscape 转换产物为空文件：${productPath}`);
    }
    // 校验一：跨信任边界的 SVG 安全门（外部二进制产物，与本仓 svg-safety 同一契约）。
    try {
      assertSafeSvg(product, DEFAULT_SVG_MAX_BYTES);
    } catch (error) {
      const reason = isSvgSafetyError(error) ? error.message : describe(error);
      return failure("render_failed", "unsafe_product", `Inkscape 转换产物未过 SVG 安全门：${reason}`);
    }
    // 校验二：文字真的没了（注释里的示例文本不算残留）。
    if (TEXT_ELEMENT_PATTERN.test(product.replace(COMMENT_PATTERN, ""))) {
      return failure(
        "render_failed",
        "text_remains",
        "Inkscape 转换产物仍含 <text> 元素：文字未转成路径，字体无关的承诺不成立（拒绝交回带字体依赖的图）",
      );
    }
    // 校验三：几何/画布守卫（近似实现，见文件头注）。
    const regression = checkOutlineGeometry(original, product);
    if (regression !== undefined) {
      return failure("render_failed", "geometry_regression", `Inkscape 转换产物几何走样：${regression}`);
    }
    // 子进程退出与写回之间仍可能被取消：写回前再查一次（原子换入一旦发生就不可收回）。
    if (input.signal?.aborted === true) {
      return failure("cancelled", "cancelled", "Inkscape 文字转路径被调用方取消（写回前）");
    }
    try {
      await writeFileAtomic(input.path, product);
    } catch (error) {
      return failure("render_failed", "write_failed", `原子写回转换产物失败（原文件未改动）：${describe(error)}`);
    }
    return {
      ok: true,
      path: input.path,
      bytesBefore: Buffer.byteLength(original, "utf8"),
      bytesAfter: Buffer.byteLength(product, "utf8"),
    };
  } finally {
    // 临时目录清理失败只会在系统临时区留下残留目录，不能把已分类的结果顶掉。
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * 几何/画布守卫：转换只该把 `<text>` 换成轮廓，图面范围与画幅都应不变。
 *
 * 判据分两层：根元素 viewBox/宽高的**严格**等价（画布被改写即拒收），以及轻量估算的墨迹包围盒
 * **只判向外越界**（文字占位框本就是上界，字形轮廓比它略小是正常的，向内收缩不作为拒收依据）。
 * 容差为 `1mm + 1% × 墨迹跨度`，故"整体位移"是在**把某一侧推出容差**时被检出（画幅被改写由第一层
 * 直接拦下），而不是任何 1mm 平移都会报——这是近似守卫的边界，如实写在这里。
 * 返回违规说明；几何一致时返回 undefined。
 */
export function checkOutlineGeometry(before: string, after: string): string | undefined {
  const canvas = checkCanvasStable(before, after);
  if (canvas !== undefined) return canvas;
  const original = estimateInkBounds(before);
  const converted = estimateInkBounds(after);
  if (converted === undefined) {
    return original === undefined ? undefined : "转换产物里没有可量测的图形（墨迹全部丢失）";
  }
  if (original === undefined) return undefined;
  const scale = mmPerUserUnit(after);
  const toMm = (bounds: InkBounds): InkBounds => ({
    minX: bounds.minX * scale,
    minY: bounds.minY * scale,
    maxX: bounds.maxX * scale,
    maxY: bounds.maxY * scale,
  });
  const beforeMm = toMm(original);
  const afterMm = toMm(converted);
  const span = Math.max(beforeMm.maxX - beforeMm.minX, beforeMm.maxY - beforeMm.minY);
  const slack = OUTLINE_GEOMETRY_SLACK_MM + OUTLINE_GEOMETRY_SLACK_RATIO * span;
  const outside =
    afterMm.minX < beforeMm.minX - slack ||
    afterMm.minY < beforeMm.minY - slack ||
    afterMm.maxX > beforeMm.maxX + slack ||
    afterMm.maxY > beforeMm.maxY + slack;
  if (!outside) return undefined;
  return `转换产物的墨迹范围 ${formatBounds(afterMm)} 超出原图 ${formatBounds(beforeMm)} 的允许范围 ${formatMm(slack)}mm（近似量测）`;
}

/** 判断目标是否为可转换的 SVG（大小写不敏感；`.svgz` 是压缩容器，不在本步骤契约内）。 */
export function isSvgTarget(path: string): boolean {
  return /\.svg$/iu.test(path.trim());
}

/** 原子写回：写**同目录**临时文件再 `rename`（同文件系统才原子；rename 失败即清理临时文件）。 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o644 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 构造结构化失败（reason 决定 code 的场景由调用点显式给出）。 */
function failure(
  code: SvgTextToPathErrorCode,
  reason: SvgTextToPathFailureReason,
  error: string,
): SvgTextToPathOutputFailure {
  return { ok: false, code, reason, error };
}

/** 失败结果类型别名（内部使用，避免在 `failure` 里重复书写联合分支）。 */
type SvgTextToPathOutputFailure = Extract<SvgTextToPathOutcome, { ok: false }>;

/** 错误对象 → 消息文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 文本截断（错误信息里只带摘录，避免把整段 stderr 塞进用户可见文案）。 */
function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MESSAGE_EXCERPT_MAX ? `${trimmed.slice(0, MESSAGE_EXCERPT_MAX)}…（已截断）` : trimmed;
}

/** 画幅严格等价判据：viewBox 与宽高（两侧都声明时才比较）。 */
function checkCanvasStable(before: string, after: string): string | undefined {
  const original = readCanvas(before);
  const converted = readCanvas(after);
  if (original.viewBox !== undefined) {
    if (converted.viewBox === undefined) {
      return `转换产物改写了画布：原图 viewBox="${original.viewBox.join(" ")}"，产物无 viewBox`;
    }
    if (!viewBoxEqual(original.viewBox, converted.viewBox)) {
      return `转换产物改写了画布：viewBox 由 "${original.viewBox.join(" ")}" 变为 "${converted.viewBox.join(" ")}"`;
    }
  }
  if (
    original.widthMm !== undefined &&
    converted.widthMm !== undefined &&
    !lengthEqual(original.widthMm, converted.widthMm)
  ) {
    return `转换产物改写了画布宽度：${formatMm(original.widthMm)}mm → ${formatMm(converted.widthMm)}mm`;
  }
  if (
    original.heightMm !== undefined &&
    converted.heightMm !== undefined &&
    !lengthEqual(original.heightMm, converted.heightMm)
  ) {
    return `转换产物改写了画布高度：${formatMm(original.heightMm)}mm → ${formatMm(converted.heightMm)}mm`;
  }
  return undefined;
}

/** 读根 `<svg>` 的画幅声明（viewBox 与宽高）。 */
function readCanvas(svg: string): CanvasInfo {
  const root = /<svg\b([^>]*)>/iu.exec(svg.replace(COMMENT_PATTERN, ""));
  const attrs = parseAttributes(root?.[1] ?? "");
  const values = numbers(attrs.get("viewBox"));
  const viewBox: readonly [number, number, number, number] | undefined =
    values.length >= 4 ? [values[0]!, values[1]!, values[2]!, values[3]!] : undefined;
  return { viewBox, widthMm: lengthToMm(attrs.get("width")), heightMm: lengthToMm(attrs.get("height")) };
}

/** viewBox 等价（绝对或相对容差取大者；Inkscape 可能把 210 写成 210.00001）。 */
function viewBoxEqual(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return a.every((value, index) => nearlyEqual(value, b[index]!, 0.01, 1e-4));
}

/** 物理长度等价（毫米；绝对容差 0.05mm 覆盖单位换算的浮点尾差）。 */
function lengthEqual(a: number, b: number): boolean {
  return nearlyEqual(a, b, 0.05, 1e-3);
}

function nearlyEqual(a: number, b: number, absolute: number, relative: number): boolean {
  const tolerance = Math.max(absolute, relative * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= tolerance;
}

/** 长度属性 → 毫米（无单位即 px；百分比等无法换算的返回 undefined）。 */
function lengthToMm(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/u.exec(raw);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  switch ((match[2] ?? "").toLowerCase()) {
    case "":
    case "px":
      return value * MM_PER_PX;
    case "mm":
      return value;
    case "cm":
      return value * 10;
    case "in":
      return value * 25.4;
    case "pt":
      return (value * 25.4) / 72;
    case "pc":
      return (value * 25.4) / 6;
    default:
      return undefined;
  }
}

/** 产物画幅换算系数（用户单位 → 毫米）：由 viewBox 与宽度共同确定，缺一侧退回 CSS px 当量。 */
function mmPerUserUnit(svg: string): number {
  const canvas = readCanvas(svg);
  if (canvas.viewBox !== undefined && canvas.widthMm !== undefined && canvas.viewBox[2] !== 0) {
    return canvas.widthMm / canvas.viewBox[2];
  }
  return MM_PER_PX;
}

/**
 * 轻量墨迹包围盒估算（**近似**，见文件头注）：只按几何属性取数值坐标，不做 transform 求逆，
 * `<path>` 的 `d` 按数值两两成对解析（含弧命令时分组会偏，属近似），文本按占位框估上界。
 * 无可量测内容时返回 undefined。
 */
function estimateInkBounds(svg: string): InkBounds | undefined {
  const body = svg.replace(COMMENT_PATTERN, "").replace(/<defs\b[\s\S]*?<\/defs>/iu, "");
  let bounds: InkBounds | undefined;
  const extend = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bounds =
      bounds === undefined
        ? { minX: x, minY: y, maxX: x, maxY: y }
        : {
            minX: Math.min(bounds.minX, x),
            minY: Math.min(bounds.minY, y),
            maxX: Math.max(bounds.maxX, x),
            maxY: Math.max(bounds.maxY, y),
          };
  };
  const extendBox = (x: number, y: number, width: number, height: number): void => {
    extend(x, y);
    extend(x + width, y + height);
  };
  for (const match of body.matchAll(/<([A-Za-z][\w:.-]*)\b([^>]*?)\/?>/gu)) {
    const name = match[1]!.toLowerCase().replace(/^[\w.-]+:/u, "");
    const attrs = parseAttributes(match[2]!);
    switch (name) {
      case "rect":
        extendBox(
          numAttr(attrs, "x") ?? 0,
          numAttr(attrs, "y") ?? 0,
          numAttr(attrs, "width") ?? 0,
          numAttr(attrs, "height") ?? 0,
        );
        break;
      case "circle": {
        const r = numAttr(attrs, "r") ?? 0;
        extendBox((numAttr(attrs, "cx") ?? 0) - r, (numAttr(attrs, "cy") ?? 0) - r, r * 2, r * 2);
        break;
      }
      case "ellipse": {
        const rx = numAttr(attrs, "rx") ?? 0;
        const ry = numAttr(attrs, "ry") ?? 0;
        extendBox((numAttr(attrs, "cx") ?? 0) - rx, (numAttr(attrs, "cy") ?? 0) - ry, rx * 2, ry * 2);
        break;
      }
      case "line":
        extend(numAttr(attrs, "x1") ?? 0, numAttr(attrs, "y1") ?? 0);
        extend(numAttr(attrs, "x2") ?? 0, numAttr(attrs, "y2") ?? 0);
        break;
      case "polygon":
      case "polyline":
        extendPairs(numbers(attrs.get("points")), extend);
        break;
      case "path":
        extendPairs(numbers(attrs.get("d")), extend);
        break;
      default:
        break;
    }
  }
  for (const match of body.matchAll(/<(?:[\w.-]+:)?text\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?text>/gu)) {
    const base = parseAttributes(match[1]!);
    for (const segment of textSegments(base, match[2]!)) {
      const fontSize = numAttr(segment.attrs, "font-size") ?? DEFAULT_ASSUMED_FONT_SIZE;
      const anchor = (segment.attrs.get("text-anchor") ?? "start").trim().toLowerCase();
      const x = numbers(segment.attrs.get("x"))[0] ?? 0;
      const y = numbers(segment.attrs.get("y"))[0] ?? 0;
      const width = estimateTextWidthEm(segment.text) * fontSize;
      const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
      extendBox(left, y - fontSize * TEXT_ASCENT_EM, width, fontSize * (TEXT_ASCENT_EM + TEXT_DESCENT_EM));
    }
  }
  return bounds;
}

/** 数值序列按 (0,1)、(2,3)… 成对取点（`points` 与 `d` 共用；弧命令的参数分组属近似）。 */
function extendPairs(values: readonly number[], extend: (x: number, y: number) => void): void {
  for (let index = 0; index + 1 < values.length; index += 2) {
    extend(values[index]!, values[index + 1]!);
  }
}

/**
 * `<text>` 的分段：有 `<tspan>` 时每段用自己的 x/y/字号（缺项继承父级），无 tspan 时整段一体。
 * 只取首个数（`x="10 20 30"` 的多位置写法按首字处理，属近似）。
 */
function textSegments(
  base: ReadonlyMap<string, string>,
  inner: string,
): { attrs: ReadonlyMap<string, string>; text: string }[] {
  const segments: { attrs: ReadonlyMap<string, string>; text: string }[] = [];
  let cursor = 0;
  let plain = "";
  for (const match of inner.matchAll(/<(?:[\w.-]+:)?tspan\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?tspan>/gu)) {
    const start = match.index;
    plain += inner.slice(cursor, start);
    cursor = start + match[0].length;
    const attrs = new Map([...base, ...parseAttributes(match[1]!)]);
    segments.push({ attrs, text: stripTags(match[2]!) });
  }
  plain += inner.slice(cursor);
  const own = stripTags(plain);
  if (own.trim().length > 0) segments.push({ attrs: base, text: own });
  return segments;
}

/** XML 标签剥离 + 实体按单字计（估算字宽用，不追求精确解码）。 */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/gu, "").replace(/&[A-Za-z#0-9]+;/gu, "x");
}

/** 按字宽比例估文本宽度（em）：全角 1.0、半角 0.6、空白 0.35。 */
function estimateTextWidthEm(text: string): number {
  let em = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      em += 0.35;
      continue;
    }
    em += isFullWidth(char) ? 1 : 0.6;
  }
  return em;
}

/** 全角/宽字符判定（CJK、假名、谚文、全角形式等码位区）。 */
function isFullWidth(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  );
}

/** 解析标签属性为只读映射（只认双引号写法：本模块面对的是 SVG 生成器产物）。 */
function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/gu)) {
    attrs.set(match[1]!, match[2]!);
  }
  return attrs;
}

/** 属性里的全部数值（`viewBox` / `x` / `points` / `d` 共用）。 */
function numbers(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const values: number[] = [];
  for (const match of raw.matchAll(NUMBER_PATTERN)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** 属性里的首个数值（`font-size="5px"` 这类带单位写法也能解析）。 */
function numAttr(attrs: ReadonlyMap<string, string>, name: string): number | undefined {
  const raw = attrs.get(name);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 毫米数值（至多三位小数）。 */
function formatMm(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatBounds(bounds: InkBounds): string {
  return `(${formatMm(bounds.minX)}, ${formatMm(bounds.minY)})-(${formatMm(bounds.maxX)}, ${formatMm(bounds.maxY)})`;
}
