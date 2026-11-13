/**
 * src/patent/figuregen — 交付物清单（内容哈希 / 大小 / 落盘时刻）与「清单 ↔ 目录现状」核验。
 *
 * 用途：把附图交付物（图形 SVG / 提交落版页 / A4 HTML / sidecar）的**内容身份**与**时序**
 * 变成可核证据。对齐 deepseek-harness 的
 * `packages/patent/patent-document/src/tool/verify-deliverable.ts`（交付物 manifest / sha256 /
 * mtime / 「渲染件晚于输入件」的时序门）。
 *
 * 本仓现状与缺口：`figure-check.json` 的 `inputs_hash` 只覆盖**附图面**，缺两条可核证据：
 * 1. 「交的那份就是案卷主路径上的那份」——靠 sha256 + 字节数绑定内容身份（改过就漂移）；
 * 2. 「渲染件不早于输入件」——靠产物 mtime 与输入件 mtime 比较（输入改了却没重生成）。
 *
 * 判据（见 {@link checkDeliverableManifest}）：
 * - `file-missing`：清单里有、当前目录里没有（含"文件在但读不到"）；
 * - `hash-mismatch`：内容 sha256 与清单不一致（**内容漂移**：文件被改过）；
 * - `size-mismatch`：字节数不一致（与 hash 同时命中时**去重**，只报 hash）；
 * - `not-in-manifest`：当前目录里有、清单里没有（**新增了没登记的产物**）；
 * - `stale-output`：产物 mtime 早于输入件 mtime（输入改了但没重生成）；每个产物**至多一条**，
 *   点名**最早**的那个输入件，不按输入件数量重复报。
 *
 * 与 DSH 的对应：DSH 在工具执行时核交付件（清单是一次性快照）；本仓的交付物是**文件**，
 * 可事后比对，故拆成两段——「装配」（{@link buildDeliverableManifest}，落盘时写清单）与
 * 「核验」（{@link checkDeliverableManifest}，事后比对目录现状）。两段共用同一份清单格式。
 *
 * 本批边界：
 * - 只判**清单一致性**与**时序**，不判图面合规（图面判据见 `check.ts`，规则族 V / RC / DR1–DR3）；
 * - 不新增工具、不改任何工具入参（`inputSchema` 零变更 ⇒ llm-replay fixture 不需重录）；
 * - 清单条目只存**文件名**（不存绝对路径）：案卷整目录搬迁后仍可用，也不把家目录写进案卷；
 * - 清单**不得登记承载它的那份 sidecar**（自指：清单写进 sidecar 的那一刻 sidecar 的哈希就变了）。
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

/** 交付物在清单里的角色。 */
export type DeliverableRole = "figure" | "submission-page" | "html" | "sidecar";

/** 清单里的一条交付物记录。 */
export type DeliverableEntry = {
  readonly role: DeliverableRole;
  /** 产物文件名（相对产物目录；不写家目录进案卷）。 */
  readonly file: string;
  /** 内容的 sha256（十六进制小写）。 */
  readonly sha256: string;
  /** 字节数。 */
  readonly bytes: number;
  /** 落盘时刻（epoch 毫秒）。 */
  readonly mtimeMs: number;
};

/** 清单校验的一类发现。 */
export type DeliverableFinding = {
  readonly id: "file-missing" | "hash-mismatch" | "size-mismatch" | "stale-output" | "not-in-manifest";
  readonly role: DeliverableRole | undefined;
  readonly file: string | undefined;
  readonly message: string;
  readonly evidence?: readonly string[];
};

/** 提交落版页文件名形态：`<name>-fig<N>-page.svg`。 */
const SUBMISSION_PAGE_PATTERN = /-fig\d+-page\.svg$/u;
/** 提交拼版页文件名形态：`<name>-fig<N>-sheet.svg`（多视图共页的整页 A4）。 */
const SUBMISSION_SHEET_PATTERN = /-fig\d+-sheet\.svg$/u;
/** 附图本体文件名形态：`<name>-fig<N>.svg`。 */
const FIGURE_PATTERN = /-fig\d+\.svg$/u;
/** sidecar 文件名形态：`<name>-figures.json`。 */
const SIDECAR_PATTERN = /-figures\.json$/u;

/**
 * 按本仓产物命名约定归类文件（供核验侧组装「当前目录里的产物」）。
 *
 * @param fileName - 文件名（不含目录）。
 * @returns 角色；不像交付产物的文件（如说明书文本、笔记）返回 undefined。
 */
export function classifyDeliverableFileName(fileName: string): DeliverableRole | undefined {
  if (SIDECAR_PATTERN.test(fileName)) return "sidecar";
  if (SUBMISSION_PAGE_PATTERN.test(fileName)) return "submission-page";
  // 拼版页也是「提交页」（A4 整页），只是装的是多幅视图 ⇒ 与落版页同角色，
  // 不新造角色值（角色值是 sidecar 清单的契约，新增值要同步改 fail-loud 解析器）。
  if (SUBMISSION_SHEET_PATTERN.test(fileName)) return "submission-page";
  if (FIGURE_PATTERN.test(fileName)) return "figure";
  if (fileName.endsWith(".svg")) return "figure";
  if (fileName.endsWith(".html")) return "html";
  return undefined;
}

/**
 * 从产物文件名取图号（`<name>-fig<N>.svg` / `<name>-fig<N>-page.svg` / `<name>-fig<N>-sheet.svg` → N）。
 *
 * @param fileName - 文件名（不含目录）。
 * @returns 图号；文件名不含图号时返回 undefined（用于核验报告的 `figure_nos`）。
 */
export function deliverableFigureNo(fileName: string): number | undefined {
  const matched = /-fig(\d+)(?:-page|-sheet)?\.svg$/u.exec(fileName);
  if (matched === null) return undefined;
  const raw = matched[1];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 文件的落盘事实（哈希 / 字节数 / mtime）；读不到时返回 undefined。 */
type FileFacts = { sha256: string; bytes: number; mtimeMs: number };

/**
 * 读一个文件的落盘事实（sha256 / 字节数 / mtime）。
 *
 * 读不到（ENOENT / EACCES 等）时返回 undefined——调用方据此按"缺失"处理，
 * 不把读不到当成"内容为空"或"已核验通过"。
 */
async function readFileFacts(path: string): Promise<FileFacts | undefined> {
  try {
    const info = await stat(path);
    const buffer = await readFile(path);
    return {
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    // 读不到（ENOENT / EACCES 等）按"缺失"处理：调用方据此跳过该条目或报 file-missing，
    // 不把"读不到"当成"内容为空"，更不当成"已核验通过"。
    return undefined;
  }
}

/**
 * 装配交付物清单：对给定的产物文件逐个算 sha256 / 字节数 / mtime。
 *
 * 读不到的条目**跳过**（不进清单）——调用方按「请求条目 − 返回条目」的差集即知哪些没登记，
 * 不得把"没写成"记成"已登记"。
 *
 * @param entries - 角色 + 文件绝对路径。
 * @returns 清单条目（file 只留文件名，路径不入案卷）。
 */
export async function buildDeliverableManifest(
  entries: readonly { readonly role: DeliverableRole; readonly path: string }[],
): Promise<DeliverableEntry[]> {
  const manifest: DeliverableEntry[] = [];
  for (const entry of entries) {
    const facts = await readFileFacts(entry.path);
    if (facts === undefined) continue;
    manifest.push({
      role: entry.role,
      file: basename(entry.path),
      sha256: facts.sha256,
      bytes: facts.bytes,
      mtimeMs: facts.mtimeMs,
    });
  }
  return manifest;
}

/** 触发"产物比输入旧"的最早输入件（mtime 最小的那条）。 */
function earliestNewerInput(
  inputs: readonly { readonly label: string; readonly mtimeMs: number }[],
  artifactMtimeMs: number,
): { label: string; mtimeMs: number } | undefined {
  let earliest: { label: string; mtimeMs: number } | undefined;
  for (const input of inputs) {
    if (input.mtimeMs <= artifactMtimeMs) continue;
    if (earliest === undefined || input.mtimeMs < earliest.mtimeMs) {
      earliest = { label: input.label, mtimeMs: input.mtimeMs };
    }
  }
  return earliest;
}

/**
 * 校验清单与当前文件是否一致，并做时序检查。
 *
 * 比对口径：
 * - 以**文件名**为键（清单只存文件名，案卷可整体搬迁）；
 * - 缺文件 = 清单里有、当前集合里没有，或文件在但读不到；
 * - 内容漂移 = sha256 不符（同时字节数也不符时**只报 hash**，不重复报两条）；
 * - 时序 = 产物的**当前** mtime 早于某输入件的 mtime（输入改了但没重生成）⇒ 每个产物至多一条，
 *   点名最早的那个输入件。
 *
 * `current` 由调用方给出——本模块只在该集合内比对，不扫描目录；不像交付产物的文件
 * （说明书文本、笔记等）不应放进 `current`，且即便放进也不会被判为"未登记产物"。
 *
 * @param manifest - 清单（来自 sidecar）。
 * @param current - 当前产物目录里的文件（角色 + 绝对路径）。
 * @param inputs - 输入件（规格/说明书文本等）的 mtime，用于「渲染件晚于输入件」时序检查。
 * @returns 发现列表；一致且时序正常时为空数组。
 */
export async function checkDeliverableManifest(args: {
  readonly manifest: readonly DeliverableEntry[];
  readonly current: readonly { readonly role: DeliverableRole; readonly path: string }[];
  readonly inputs?: readonly { readonly label: string; readonly mtimeMs: number }[];
}): Promise<DeliverableFinding[]> {
  const findings: DeliverableFinding[] = [];
  const currentByFile = new Map<string, { role: DeliverableRole; path: string }>();
  for (const item of args.current) {
    currentByFile.set(basename(item.path), item);
  }
  const manifestFiles = new Set(args.manifest.map(entry => entry.file));
  const inputs = args.inputs ?? [];

  for (const entry of args.manifest) {
    const item = currentByFile.get(entry.file);
    if (item === undefined) {
      findings.push({
        id: "file-missing",
        role: entry.role,
        file: entry.file,
        message: `交付物缺失：清单登记的 ${entry.file} 不在当前产物目录中`,
        evidence: [`清单登记 sha256=${entry.sha256}`, `清单登记 mtimeMs=${entry.mtimeMs}`],
      });
      continue;
    }
    const facts = await readFileFacts(item.path);
    if (facts === undefined) {
      findings.push({
        id: "file-missing",
        role: entry.role,
        file: entry.file,
        message: `交付物不可读：清单登记的 ${entry.file} 读不到（文件被删除或不可访问）`,
        evidence: [`清单登记 sha256=${entry.sha256}`],
      });
      continue;
    }
    const hashMismatch = facts.sha256 !== entry.sha256;
    const sizeMismatch = facts.bytes !== entry.bytes;
    if (hashMismatch) {
      findings.push({
        id: "hash-mismatch",
        role: entry.role,
        file: entry.file,
        message: `交付物内容漂移：${entry.file} 的 sha256 与清单登记值不一致（文件在登记后被改过）`,
        evidence: [`清单登记 sha256=${entry.sha256}`, `实际 sha256=${facts.sha256}`],
      });
    } else if (sizeMismatch) {
      findings.push({
        id: "size-mismatch",
        role: entry.role,
        file: entry.file,
        message: `交付物大小漂移：${entry.file} 的字节数与清单登记值不一致`,
        evidence: [`清单登记 bytes=${entry.bytes}`, `实际 bytes=${facts.bytes}`],
      });
    }
    // 时序门：产物落盘早于输入件 ⇒ 输入已变更但没有重新生成。
    const staleInput = earliestNewerInput(inputs, facts.mtimeMs);
    if (staleInput !== undefined) {
      findings.push({
        id: "stale-output",
        role: entry.role,
        file: entry.file,
        message:
          `交付物早于输入件：${entry.file} 的落盘时刻早于输入件「${staleInput.label}」` + `（输入已变更但未重新生成）`,
        evidence: [`产物 mtimeMs=${facts.mtimeMs}`, `输入件 ${staleInput.label} mtimeMs=${staleInput.mtimeMs}`],
      });
    }
  }

  for (const item of args.current) {
    const file = basename(item.path);
    if (manifestFiles.has(file)) continue;
    // 非产物文件（说明书文本、笔记等）不参与"新增未登记产物"判定。
    if (classifyDeliverableFileName(file) === undefined) continue;
    findings.push({
      id: "not-in-manifest",
      role: item.role,
      file,
      message: `产物未登记：${file} 在产物目录中但不在交付物清单里（新增产物未登记）`,
      evidence: [`清单已登记 ${args.manifest.length} 条`],
    });
  }

  return findings;
}

/**
 * 解析 sidecar 里的 `deliverables` 清单（结构不合法即抛错，fail-loud）。
 *
 * 为什么 fail-loud：清单是**交付契约**的一部分，被手工改坏时必须报错，不能被当作
 * "没有清单"静默通过——否则核验侧会把"清单坏了"呈现成"清单未登记"。
 *
 * @param value - sidecar JSON 里的 `deliverables` 字段（缺省时传 undefined）。
 * @returns 清单条目；字段缺省时返回 undefined（**旧 sidecar 无此字段是合法的**）。
 */
export function parseDeliverableEntries(value: unknown): DeliverableEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("附图 sidecar 的 deliverables 应为数组");
  }
  return value.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`附图 sidecar deliverables[${index}] 应为对象`);
    }
    const entry = raw as Record<string, unknown>;
    const role = entry.role;
    if (role !== "figure" && role !== "submission-page" && role !== "html" && role !== "sidecar") {
      throw new TypeError(`附图 sidecar deliverables[${index}].role 取值非法: ${String(role)}`);
    }
    const file = entry.file;
    if (typeof file !== "string" || file.length === 0) {
      throw new TypeError(`附图 sidecar deliverables[${index}].file 应为非空字符串`);
    }
    const sha256 = entry.sha256;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new TypeError(`附图 sidecar deliverables[${index}].sha256 应为 64 位小写十六进制`);
    }
    const bytes = entry.bytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      throw new TypeError(`附图 sidecar deliverables[${index}].bytes 应为非负数字`);
    }
    const mtimeMs = entry.mtimeMs;
    if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
      throw new TypeError(`附图 sidecar deliverables[${index}].mtimeMs 应为数字`);
    }
    return { role, file, sha256, bytes, mtimeMs };
  });
}
