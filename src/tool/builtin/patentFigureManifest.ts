/**
 * patent_figure_manifest — 附图交付物清单（登记 + 校验）的**工具化暴露**。
 *
 * 清单能力本体在 `src/patent/figuregen/deliverable-manifest.ts`（纯模块：装配 / 核验 /
 * 清单解析），本文件**不改核心模块逻辑**，只做三件事：
 * 1. 把模型可给的入参落到模块的三个函数上（{@link buildDeliverableManifest} 装配、
 *    {@link checkDeliverableManifest} 核验、{@link parseDeliverableEntries} 解析清单）；
 * 2. 把结论按**三态**如实返回（不把「没登记 / 读不到」说成「已核验通过」）；
 * 3. 提供一份人读报告（模型先读文本，再读 data）。
 *
 * ## 三态口径（与仓库既有 DR4 口径同源，见 `patentFigureCheckReport.ts`）
 *
 * - `verified`：本次**确实核验过**——check 模式完成了「清单 ↔ 当前文件」比对；
 *   build 模式完成了清单装配且条目完整（每条都自实际读盘算出，不是凭空写的）。
 * - `not-registered`：**没有登记清单**（sidecar 不存在 / 无 `deliverables` 字段）
 *   ⇒ 本次**未核验**，`ok=false`，不判通过。
 * - `unavailable`：清单载体或产物目录读不到 ⇒ 本次**未核验**，`ok=false`，不判通过。
 *
 * 「没登记」与「未核验」**不得**表述成「已核验通过」：旧 sidecar 没有 `deliverables`
 * 字段是**合法**的（可选字段，见 `FigureSidecar.deliverables`），此时工具必须报
 * `not-registered`，而不是把「没东西可比」说成「比过了、一致」。
 *
 * ## 边界
 *
 * - **只读**：build 模式也只读盘不写盘——清单只出现在返回值里（写进 sidecar 由生成侧
 *   `patent_figure_generate` / 调用方负责），故 `isReadOnly` 恒为 true。
 * - **不自指**：清单**不得登记承载它的那份 sidecar**（清单写进 sidecar 的那一刻
 *   sidecar 的哈希就变了）⇒ sidecar 自身一律从登记集合与比对集合两侧排除。
 * - **时序门**：check 模式在 sidecar 登记了 `deliverableInputs` 时执行「渲染件不早于
 *   输入件」；未登记 ⇒ 时序门**不执行**，报告如实声明（不判通过也不假装测过）。
 *
 * 与生成侧的分工：`patent_figure_generate` 在落盘时写清单（sidecar 的 `deliverables`），
 * 本工具负责**事后核验**与**独立装配**（把外部产物登记成清单）。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildDeliverableManifest,
  checkDeliverableManifest,
  classifyDeliverableFileName,
  deliverableFigureNo,
  parseDeliverableEntries,
  type DeliverableEntry,
  type DeliverableFinding,
  type DeliverableRole,
} from "../../patent/figuregen/deliverable-manifest.js";
import { parseFigureSidecar, type FigureSidecar } from "../../patent/figuregen/sidecar.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { assertFigureOutputName } from "./patentFigureShared.js";

/** 工具名（错误详情与报告里用）。 */
const TOOL = "patent_figure_manifest";

/**
 * 本次核验状态（三态）。
 *
 * `verified` ≠ 「什么都没查也通过了」：它意味着**确实做了比对**；
 * `not-registered` / `unavailable` 都表示**本次未核验**（`ok` 必为 false）。
 */
export type PatentFigureManifestChecked = "verified" | "not-registered" | "unavailable";

/** 清单发现的级别（与 DR4 的级别映射一致：漂移/缺失 = fail，可疑未证伪 = warn）。 */
export type PatentFigureManifestSeverity = "fail" | "warn";

/**
 * 一条清单发现。
 *
 * 字段取自 {@link DeliverableFinding}（`id` → `kind`，`message`/`file`/`role`/`evidence`
 * 原样携带），另加 `severity`（模块的发现不带级别，级别由 DR4 的既有映射给出）。
 */
export type PatentFigureManifestFinding = {
  /** 发现类别（`DeliverableFinding.id`）。 */
  kind: DeliverableFinding["id"];
  /** 级别：内容漂移/缺文件 = fail；未登记产物/时序倒挂 = warn。 */
  severity: PatentFigureManifestSeverity;
  /** 人读说明。 */
  message: string;
  /** 涉及的产物文件名（缺省）。 */
  file?: string;
  /** 产物角色（缺省）。 */
  role?: DeliverableRole;
  /** 证据行（缺省）。 */
  evidence?: string[];
};

/** 工具入参（三选一即可定位交付物集合）。 */
export type PatentFigureManifestInput = {
  /** `build` = 装配清单；`check` = 核验清单（缺省 check）。 */
  mode?: string;
  /** `<name>-figures.json` sidecar 路径（清单通常记在它的 `deliverables` 字段里）。 */
  sidecar_path?: string;
  /** 产物目录（与 `output_name` 成对给出）。 */
  output_dir?: string;
  /** 产物文件名主干（与 `output_dir` 成对给出）。 */
  output_name?: string;
  /** 直接给定要登记/校验的文件（绝对路径或相对 cwd）。 */
  files?: string[];
};

/** 工具输出（canonical data）。 */
export type PatentFigureManifestOutput = {
  /** 本次模式。 */
  mode: "build" | "check";
  /** 本次动作无异常（check 模式＝核验通过；build 模式＝装配完整）。 */
  ok: boolean;
  /** 本次核验状态（三态）。 */
  checked: PatentFigureManifestChecked;
  /** 人读结论（说明本次到底做了什么、为什么是这个状态）。 */
  note: string;
  /** 清单条目（check 模式＝被核验的清单；build 模式＝本次装配出的清单）。 */
  manifest: DeliverableEntry[];
  /** 清单发现。 */
  findings: PatentFigureManifestFinding[];
};

/**
 * 发现类别 → 级别（与 `patentFigureCheck.ts` 的 DR4 映射同口径）：
 * 内容漂移 / 缺文件 = `fail`（交出去的不是登记的那份，或登记的那份不见了）；
 * 未登记产物 / 时序倒挂 = `warn`（可疑但未证伪）。
 */
const FINDING_SEVERITY: Record<DeliverableFinding["id"], PatentFigureManifestSeverity> = {
  "file-missing": "fail",
  "hash-mismatch": "fail",
  "size-mismatch": "fail",
  "not-in-manifest": "warn",
  "stale-output": "warn",
};

/** 一个交付物候选（角色 + 文件名 + 绝对路径）。 */
type ArtifactCandidate = {
  role: DeliverableRole;
  file: string;
  path: string;
};

/** 产物集合的定位方式（三选一）。 */
type ManifestLocator =
  | { kind: "sidecar"; sidecarPath: string }
  | { kind: "dir"; dir: string; outputName: string }
  | { kind: "files"; paths: string[] };

/** 正则元字符转义（output_name 拼进产物命名形态的正则里）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 产物命名形态判定（**严格**按本仓约定推导）。
 *
 * 为什么不用 `classifyDeliverableFileName` 直接判成员资格：它的兜底规则是
 * 「任何 `.svg` 都是 figure」，会把同目录里别的图（`<other>-fig1.svg`、随手改名的图）
 * 也算成产物 ⇒ 登记集合与比对集合都会失真。这里用**主干前缀 + 图号**的严格形态
 * 判成员资格，再用 `classifyDeliverableFileName` 取角色（角色口径与清单契约一致）。
 *
 * @param outputName - 产物文件名主干（`figs`）。
 * @param fileName - 目录里的文件名（不含目录）。
 * @returns 角色；不符合本仓产物命名约定时返回 undefined。
 */
function artifactRole(outputName: string, fileName: string): DeliverableRole | undefined {
  const esc = escapeRegExp(outputName);
  const isArtifact =
    new RegExp(`^${esc}-fig\\d+\\.svg$`, "u").test(fileName) ||
    new RegExp(`^${esc}-fig\\d+-page\\.svg$`, "u").test(fileName) ||
    new RegExp(`^${esc}-fig\\d+-sheet\\.svg$`, "u").test(fileName) ||
    new RegExp(`^${esc}-figures\\.html$`, "u").test(fileName) ||
    new RegExp(`^${esc}-figures\\.json$`, "u").test(fileName);
  if (!isArtifact) return undefined;
  return classifyDeliverableFileName(fileName);
}

/**
 * 从产物文件名反推文件名主干（`<name>-fig<N>.svg` / `<name>-figures.html` → `<name>`）。
 *
 * @param fileName - 文件名（不含目录）。
 * @returns 主干；文件名不带图号/约定后缀时返回 undefined。
 */
function deriveOutputName(fileName: string): string | undefined {
  const figure = /^(.+)-fig\d+(?:-page|-sheet)?\.svg$/u.exec(fileName);
  if (figure?.[1] !== undefined) return figure[1];
  const named = /^(.+)-figures\.(?:html|json)$/u.exec(fileName);
  if (named?.[1] !== undefined) return named[1];
  return undefined;
}

/** 绝对化路径（相对路径按 cwd 解析）。 */
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * 扫描产物目录里的交付物（严格命名形态）。
 *
 * @param dir - 产物目录。
 * @param outputName - 产物文件名主干。
 * @returns 候选交付物（按文件名升序）；目录不存在 ⇒ 空数组（调用方按「该目录无产物」处理）。
 */
async function scanArtifacts(dir: string, outputName: string): Promise<ArtifactCandidate[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const candidates: ArtifactCandidate[] = [];
  for (const name of names) {
    const role = artifactRole(outputName, name);
    if (role === undefined) continue;
    candidates.push({ role, file: name, path: resolve(dir, name) });
  }
  return candidates;
}

/** sidecar 读取结果。 */
type SidecarRead =
  | { status: "ok"; sidecar: FigureSidecar; manifest: DeliverableEntry[] | undefined }
  | { status: "missing"; reason: string }
  | { status: "unreadable"; reason: string };

/**
 * 读 sidecar 并取清单（`deliverables` 字段）。
 *
 * - 文件不存在 ⇒ `missing`（⇒ 口径上的「未登记」，不是「读不到」）；
 * - 文件在但读不了（权限等）⇒ `unreadable`；
 * - 文件在但**结构坏了** ⇒ **抛错**（fail-loud）：清单坏了必须报错，
 *   不能被当作「没有清单」静默通过（见 `parseDeliverableEntries` 的模块头注）。
 */
async function readSidecarManifest(path: string): Promise<SidecarRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = err instanceof Error ? err.message : String(err);
    return code === "ENOENT"
      ? { status: "missing", reason: `sidecar 不存在：${path}` }
      : { status: "unreadable", reason: `sidecar 读取失败：${reason}` };
  }
  let sidecar: FigureSidecar;
  try {
    sidecar = parseFigureSidecar(text);
  } catch (err) {
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `附图 sidecar 解析失败（${path}）：${err instanceof Error ? err.message : String(err)}` +
        "（清单坏了必须报错，不能当作「没有清单」静默通过）",
      { tool: TOOL, sidecar_path: path },
    );
  }
  // 清单本体：走模块的 fail-loud 解析器（结构非法即抛错；旧 sidecar 无此字段 ⇒ undefined）。
  const raw = JSON.parse(text) as unknown;
  const rawRecord = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const manifest = parseDeliverableEntries((rawRecord as Record<string, unknown>).deliverables);
  return { status: "ok", sidecar, manifest };
}

/** 模式解析（缺省 check；非法值 fail-loud）。 */
function resolveMode(mode: string | undefined): "build" | "check" {
  if (mode === undefined) return "check";
  if (mode === "build" || mode === "check") return mode;
  throw new SatiToolRuntimeError("invalid_tool_input", `mode 只能是 build 或 check，收到：${mode}`, { tool: TOOL });
}

/**
 * 定位交付物集合（三选一，互斥）。
 *
 * 为什么要互斥：三种定位方式给出的集合口径不同（sidecar ⇒ 同名产物全集；
 * dir+name ⇒ 该主干的全集；files ⇒ 调用方点名的子集）⇒ 同时给出会让「比的是什么」变得
 * 不确定，宁可报错也不猜。
 */
function resolveLocator(input: PatentFigureManifestInput, cwd: string): ManifestLocator {
  const hasSidecar = input.sidecar_path !== undefined;
  const hasDir = input.output_dir !== undefined || input.output_name !== undefined;
  const hasFiles = input.files !== undefined;
  const given = [hasSidecar, hasDir, hasFiles].filter(Boolean).length;
  if (given === 0) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      "三选一给出交付物集合：sidecar_path / output_dir+output_name / files",
      { tool: TOOL },
    );
  }
  if (given > 1) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      "sidecar_path / output_dir+output_name / files 三者只能选一个（否则「比的是什么」不确定）",
      { tool: TOOL },
    );
  }
  if (input.sidecar_path !== undefined) {
    const raw = input.sidecar_path.trim();
    if (raw.length === 0) {
      throw new SatiToolRuntimeError("invalid_tool_input", "sidecar_path 不得为空串", { tool: TOOL });
    }
    return { kind: "sidecar", sidecarPath: resolvePath(cwd, raw) };
  }
  if (hasDir) {
    if (input.output_dir === undefined || input.output_name === undefined) {
      throw new SatiToolRuntimeError("invalid_tool_input", "output_dir 与 output_name 须成对给出", { tool: TOOL });
    }
    assertFigureOutputName(input.output_name, TOOL);
    const dir = input.output_dir.trim();
    if (dir.length === 0) {
      throw new SatiToolRuntimeError("invalid_tool_input", "output_dir 不得为空串", { tool: TOOL });
    }
    return { kind: "dir", dir: resolvePath(cwd, dir), outputName: input.output_name };
  }
  const files = input.files ?? [];
  if (files.length === 0) {
    throw new SatiToolRuntimeError("invalid_tool_input", "files 不得为空数组", { tool: TOOL });
  }
  return { kind: "files", paths: files.map(file => resolvePath(cwd, file)) };
}

/** 模块的发现 → 工具的发现（补上级别）。 */
function toManifestFinding(finding: DeliverableFinding): PatentFigureManifestFinding {
  return {
    kind: finding.id,
    severity: FINDING_SEVERITY[finding.id],
    message: finding.message,
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.role === undefined ? {} : { role: finding.role }),
    ...(finding.evidence === undefined ? {} : { evidence: [...finding.evidence] }),
  };
}

/**
 * build 模式：装配清单（登记当前文件 + 哈希 + 字节 + mtime）。
 *
 * 只读盘不写盘：清单只出现在返回值里（写进 sidecar 由生成侧/调用方负责）。
 */
async function runBuild(args: { locator: ManifestLocator }): Promise<PatentFigureManifestOutput> {
  const findings: PatentFigureManifestFinding[] = [];
  let candidates: ArtifactCandidate[] = [];
  let source = "";

  if (args.locator.kind === "sidecar") {
    const read = await readSidecarManifest(args.locator.sidecarPath);
    if (read.status !== "ok") {
      return {
        mode: "build",
        ok: false,
        checked: "unavailable",
        note: `本次未装配清单（${read.reason}）：没有可参照的产物集合`,
        manifest: [],
        findings: [],
      };
    }
    const dir = dirname(args.locator.sidecarPath);
    candidates = await scanArtifacts(dir, read.sidecar.output_name);
    source = `sidecar ${args.locator.sidecarPath}（output_name=${read.sidecar.output_name}）`;
  } else if (args.locator.kind === "dir") {
    candidates = await scanArtifacts(args.locator.dir, args.locator.outputName);
    source = `目录 ${args.locator.dir}（output_name=${args.locator.outputName}）`;
  } else {
    for (const path of args.locator.paths) {
      const file = basename(path);
      const role = classifyDeliverableFileName(file);
      if (role === undefined) {
        findings.push({
          kind: "not-in-manifest",
          severity: "warn",
          message: `文件名不符合交付物命名约定，未登记进清单：${file}`,
          file,
        });
        continue;
      }
      candidates.push({ role, file, path });
    }
    source = `调用方给定的 ${String(args.locator.paths.length)} 个文件`;
  }

  // sidecar 自身不登记（自指：清单写进 sidecar 的那一刻它的哈希就变了）。
  const registrable = candidates.filter(candidate => candidate.role !== "sidecar");
  for (const skipped of candidates.filter(candidate => candidate.role === "sidecar")) {
    findings.push({
      kind: "not-in-manifest",
      severity: "warn",
      message: `sidecar 自身不登记进清单（自指：清单写进 sidecar 的那一刻它的哈希就变了）：${skipped.file}`,
      file: skipped.file,
      role: skipped.role,
    });
  }

  const manifest = await buildDeliverableManifest(
    registrable.map(candidate => ({ role: candidate.role, path: candidate.path })),
  );
  const registered = new Set(manifest.map(entry => entry.file));
  const missing = registrable.filter(candidate => !registered.has(candidate.file));
  for (const candidate of missing) {
    findings.push({
      kind: "file-missing",
      severity: "fail",
      message: `交付物不可读，未登记进清单：${candidate.file}（清单只登记实际读到的文件）`,
      file: candidate.file,
      role: candidate.role,
    });
  }

  const ok = findings.every(finding => finding.severity !== "fail");
  const checked: PatentFigureManifestChecked =
    missing.length > 0 ? "unavailable" : manifest.length === 0 ? "not-registered" : "verified";
  const note =
    checked === "verified"
      ? `清单已装配：${String(manifest.length)} 条交付物均自实际读盘算出（来源：${source}）；本次未做目录现状比对`
      : checked === "unavailable"
        ? `清单装配不完整：有 ${String(missing.length)} 个文件读不到（来源：${source}）`
        : `本次未登记任何交付物（来源：${source}）`;
  return { mode: "build", ok, checked, note, manifest, findings };
}

/**
 * check 模式：核验清单（比对登记内容与当前文件）。
 *
 * 清单载体恒为 sidecar 的 `deliverables` 字段：`sidecar_path` 直接给出；
 * `output_dir+output_name` 按约定拼出 `<name>-figures.json`；`files` 从首个文件名反推
 * 主干（同目录的 `<name>-figures.json`），推不出时回退到目录内首个 sidecar。
 */
async function runCheck(args: { locator: ManifestLocator }): Promise<PatentFigureManifestOutput> {
  let sidecarPath: string | undefined;
  const currentCandidates: ArtifactCandidate[] = [];

  if (args.locator.kind === "sidecar") {
    sidecarPath = args.locator.sidecarPath;
  } else if (args.locator.kind === "dir") {
    sidecarPath = join(args.locator.dir, `${args.locator.outputName}-figures.json`);
  } else {
    const first = args.locator.paths[0];
    if (first !== undefined) {
      const dir = dirname(first);
      const derived = deriveOutputName(basename(first));
      sidecarPath = derived === undefined ? await findFirstSidecar(dir) : join(dir, `${derived}-figures.json`);
    }
    for (const path of args.locator.paths) {
      const file = basename(path);
      const role = classifyDeliverableFileName(file);
      if (role === undefined) continue;
      currentCandidates.push({ role, file, path });
    }
  }

  if (sidecarPath === undefined) {
    return {
      mode: "check",
      ok: false,
      checked: "not-registered",
      note: "本次未核验：未找到登记清单的 sidecar（清单未登记，不判通过）",
      manifest: [],
      findings: [],
    };
  }

  const read = await readSidecarManifest(sidecarPath);
  if (read.status === "missing") {
    return {
      mode: "check",
      ok: false,
      checked: "not-registered",
      note: `本次未核验：${read.reason}（清单未登记，不判通过）`,
      manifest: [],
      findings: [],
    };
  }
  if (read.status === "unreadable") {
    return {
      mode: "check",
      ok: false,
      checked: "unavailable",
      note: `本次未核验：${read.reason}（清单读不到，不判通过）`,
      manifest: [],
      findings: [],
    };
  }

  const sidecarFile = basename(sidecarPath);
  const manifest = (read.manifest ?? []).filter(entry => entry.file !== sidecarFile);
  if (read.manifest === undefined) {
    return {
      mode: "check",
      ok: false,
      checked: "not-registered",
      note: `本次未核验：sidecar ${sidecarFile} 无 deliverables 字段（清单未登记，不判通过）`,
      manifest: [],
      findings: [],
    };
  }

  // 比对集合：sidecar / dir 定位 ⇒ 同名产物全集（排除 sidecar 自身）；
  // files 定位 ⇒ 调用方点名的文件（同样排除 sidecar 自身）。
  let current = currentCandidates;
  if (args.locator.kind === "sidecar" || args.locator.kind === "dir") {
    const dir = args.locator.kind === "sidecar" ? dirname(sidecarPath) : args.locator.dir;
    const outputName = args.locator.kind === "sidecar" ? read.sidecar.output_name : args.locator.outputName;
    current = await scanArtifacts(dir, outputName);
  }
  current = current.filter(candidate => candidate.file !== sidecarFile);

  const findings = await checkDeliverableManifest({
    manifest,
    current: current.map(candidate => ({ role: candidate.role, path: candidate.path })),
    ...(read.sidecar.deliverableInputs === undefined ? {} : { inputs: read.sidecar.deliverableInputs }),
  });
  const mapped = findings.map(toManifestFinding);
  const ok = mapped.every(finding => finding.severity !== "fail");
  const timingNote =
    read.sidecar.deliverableInputs === undefined
      ? "；时序门未执行（sidecar 未登记输入件落盘时刻）"
      : "；时序门已执行（产物 mtime 与输入件 mtime 比对）";
  return {
    mode: "check",
    ok,
    checked: "verified",
    note:
      `本次已核验：清单 ${String(manifest.length)} 条 ↔ 当前文件 ${String(current.length)} 个逐一比对完成` +
      `，发现 ${String(mapped.length)} 条` +
      timingNote,
    manifest,
    findings: mapped,
  };
}

/** 目录内首个 sidecar（按文件名升序，保证确定性）。 */
async function findFirstSidecar(dir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    // 目录不可读（不存在 / 无权限）⇒ 本次无法定位 sidecar，交由上层如实报
    // 「unavailable（未核验）」，而不是假装清单为空。
    return undefined;
  }
  const first = names.find(name => name.endsWith("-figures.json"));
  return first === undefined ? undefined : join(dir, first);
}

/** 清单条目的报告行（角色 + 文件名 + 图号 + 哈希摘要 + 字节 + 落盘时刻）。 */
function manifestLine(entry: DeliverableEntry): string {
  const figureNo = deliverableFigureNo(entry.file);
  const suffix = figureNo === undefined ? "" : `（图 ${String(figureNo)}）`;
  return `- ${entry.role} ${entry.file}${suffix} sha256=${entry.sha256.slice(0, 12)}… bytes=${String(entry.bytes)} mtime=${new Date(entry.mtimeMs).toISOString()}`;
}

/**
 * 人读报告（模型先读文本，再读 data）。
 *
 * 措辞按模式分开：**build 说「装配」，check 说「核验」**——装配完整不等于核验通过，
 * 两件事不共用一句话（否则「装配完成」会被读成「已核验通过」）。
 */
function buildReportLines(output: PatentFigureManifestOutput): string[] {
  const lines: string[] = [];
  const checkStateText: Record<PatentFigureManifestChecked, string> = {
    verified: "已核验（verified）",
    "not-registered": "未核验·清单未登记（not-registered）",
    unavailable: "未核验·读不到（unavailable）",
  };
  const buildStateText: Record<PatentFigureManifestChecked, string> = {
    verified: "装配完整（verified）",
    "not-registered": "未登记任何交付物（not-registered）",
    unavailable: "装配不完整·有文件读不到（unavailable）",
  };
  lines.push(
    output.mode === "build"
      ? `交付物清单装配（mode=build）：${buildStateText[output.checked]}`
      : `交付物清单核验（mode=check）：${checkStateText[output.checked]}`,
  );
  lines.push(output.note);
  if (output.manifest.length > 0) {
    lines.push(`清单条目（${String(output.manifest.length)} 条）：`);
    lines.push(...output.manifest.map(manifestLine));
  }
  if (output.findings.length > 0) {
    lines.push(`发现（${String(output.findings.length)} 条）：`);
    for (const finding of output.findings) {
      lines.push(`- [${finding.severity}] ${finding.kind}：${finding.message}`);
      for (const evidence of finding.evidence ?? []) {
        lines.push(`    证据：${evidence}`);
      }
    }
  }
  if (output.checked !== "verified") {
    lines.push("结论：本次未核验（不判通过）——不把「没登记 / 读不到」表述成「已核验通过」。");
  } else if (output.ok) {
    lines.push("结论：本次动作无异常。");
  } else {
    lines.push("结论：本次存在 fail 级问题（见上），不得当作已核验通过。");
  }
  return lines;
}

/**
 * 附图交付物清单工具（登记 + 核验）。
 *
 * 清单能力本体在 `src/patent/figuregen/deliverable-manifest.ts`，本工具只做暴露与
 * 三态如实汇报，不改核心模块逻辑。
 */
export function createPatentFigureManifestTool(): SatiToolDefinition<PatentFigureManifestInput> {
  return {
    name: "patent_figure_manifest",
    aliases: ["PatentFigureManifest", "figure_manifest"],
    title: "Patent Figure Deliverable Manifest",
    description:
      "Register and verify the patent figure deliverable manifest (sha256 / size / mtime of every delivered " +
      "artifact). Provide exactly one locator: sidecar_path (a <name>-figures.json sidecar whose deliverables " +
      "field holds the manifest), output_dir + output_name, or files. mode=build assembles the manifest from the " +
      "files on disk (read-only); mode=check (default) compares the registered manifest against the current files " +
      "and reports file-missing / hash-mismatch / not-in-manifest / stale-output. checked is the honest " +
      "three-state: verified (actually compared), not-registered (nothing was verified, ok=false), unavailable " +
      "(unreadable, ok=false). Rule catalog: `patent-illustrator` skill.",
    kind: "custom",
    domain: "patent",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "ok", "checked", "note", "manifest", "findings"],
      properties: {
        mode: { type: "string", enum: ["build", "check"], description: "本次模式：build=装配清单；check=核验清单" },
        ok: {
          type: "boolean",
          description: "本次动作无异常（check 模式＝核验通过；build 模式＝装配完整）；未核验时恒为 false",
        },
        checked: {
          type: "string",
          enum: ["verified", "not-registered", "unavailable"],
          description:
            "本次核验状态：verified=确实比对过；not-registered=清单未登记（未核验）；unavailable=读不到（未核验）",
        },
        note: { type: "string", description: "人读结论：本次做了什么、为什么是这个状态" },
        manifest: {
          type: "array",
          description: "清单条目（check 模式＝被核验的清单；build 模式＝本次装配出的清单）",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["role", "file", "sha256", "bytes", "mtimeMs"],
            properties: {
              role: {
                type: "string",
                enum: ["figure", "submission-page", "html", "sidecar"],
                description: "交付物角色",
              },
              file: { type: "string", description: "产物文件名（相对产物目录）" },
              sha256: { type: "string", description: "内容 sha256（十六进制小写）" },
              bytes: { type: "number", description: "字节数" },
              mtimeMs: { type: "number", description: "落盘时刻（epoch 毫秒）" },
            },
          },
        },
        findings: {
          type: "array",
          description: "清单发现（file-missing / hash-mismatch / size-mismatch / stale-output / not-in-manifest）",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "severity", "message"],
            properties: {
              kind: {
                type: "string",
                enum: ["file-missing", "hash-mismatch", "size-mismatch", "stale-output", "not-in-manifest"],
                description: "发现类别",
              },
              severity: {
                type: "string",
                enum: ["fail", "warn"],
                description: "级别（fail=不可交付；warn=可疑未证伪）",
              },
              message: { type: "string", description: "人读说明" },
              file: { type: "string", description: "涉及的产物文件名（缺省）" },
              role: {
                type: "string",
                enum: ["figure", "submission-page", "html", "sidecar"],
                description: "产物角色（缺省）",
              },
              evidence: { type: "array", items: { type: "string" }, description: "证据行（缺省）" },
            },
          },
        },
      },
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["build", "check"],
          description: "build=装配清单（登记当前文件）；check=核验清单（缺省）。两种模式都只读盘不写盘。",
        },
        sidecar_path: {
          type: "string",
          description: "<name>-figures.json sidecar 路径。",
        },
        output_dir: { type: "string", description: "产物目录（与 output_name 成对）。" },
        output_name: { type: "string", description: "产物文件名主干（与 output_dir 成对给出）。" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "直接给定要登记/校验的文件（绝对路径或相对 cwd）。",
        },
      },
    },
    // 只读：build 模式也只读盘不写盘（清单只在返回值里）。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input: PatentFigureManifestInput, context: SatiToolRuntimeContext) {
      try {
        const mode = resolveMode(input.mode);
        const locator = resolveLocator(input, context.cwd);
        const output = mode === "build" ? await runBuild({ locator }) : await runCheck({ locator });
        return {
          content: [{ type: "text", text: buildReportLines(output).join("\n") }],
          data: output,
        };
      } catch (err) {
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `${TOOL} 执行失败: ${message}`, {
          tool: TOOL,
        });
      }
    },
  };
}
