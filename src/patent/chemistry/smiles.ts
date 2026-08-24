/**
 * src/patent/chemistry — SMILES 校验与规范化（RDKit WASM + 正则降级）。
 *
 * 防幻觉第一环：任何来源的 SMILES 必须先过本模块校验，非法即不可用。
 *
 * G7 验证结论（@rdkit/rdkit 2025.3.4）：MinimalLib 未暴露
 * get_canonical_smiles / get_molecular_formula —— 规范化用 mol.get_smiles()
 * （由分子对象重新生成，即规范化），分子式用 InChI 公式段提取
 * （InChI=1S/C9H8O4/... → C9H8O4），两者均不可用时回退正则元素计数（近似）。
 *
 * RDKit WASM 加载失败（Node/打包环境缺 wasm 资产）时降级为语法正则预检，
 * 不阻塞 L1 上线——校验结果标记 degraded，调用方追加 warning 并进入人工复核。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { JSMol, RDKitModule } from "@rdkit/rdkit";
import { createLogger } from "../../telemetry/index.js";

const logger = createLogger("chemistry");

/** RDKit loader 形状（d.ts 仅在 Window 上声明，Node 侧自行定义）。 */
type RDKitLoader = (options?: { wasmBinary?: Uint8Array; locateFile?: () => string }) => Promise<RDKitModule>;

/** SMILES 校验结果。 */
export type SmilesValidationResult = {
  ok: boolean;
  /** 规范化 SMILES（仅 ok=true）。 */
  canonicalSmiles?: string;
  /** 分子式（仅 ok=true 且可提取）。 */
  formula?: string;
  /** InChI（仅 ok=true）。 */
  inchi?: string;
  /** InChIKey（仅 ok=true 且可计算）。 */
  inchikey?: string;
  /** RDKit 不可用时为 true（仅语法预检通过，结构合法性未验证）。 */
  degraded?: boolean;
  /** 失败/降级原因。 */
  error?: string;
};

let modulePromise: Promise<RDKitModule | undefined> | undefined;
let loadFailureLogged = false;

/** 加载 RDKit WASM（单例；失败缓存 undefined，不重复尝试）。 */
export async function loadRdkitModule(): Promise<RDKitModule | undefined> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const require = createRequire(import.meta.url);
        const gluePath = require.resolve("@rdkit/rdkit/dist/RDKit_minimal.js");
        const wasmPath = path.join(path.dirname(gluePath), "RDKit_minimal.wasm");
        const loader = require(gluePath) as RDKitLoader;
        return await loader({ wasmBinary: readFileSync(wasmPath), locateFile: () => wasmPath });
      } catch (error) {
        // 评审 L1：加载失败提示一次（降级为语法预检的根因可追溯），不重复刷屏
        if (!loadFailureLogged) {
          loadFailureLogged = true;
          logger.warn(
            "RDKit WASM 加载失败，SMILES 校验降级为语法预检：",
            error instanceof Error ? error.message : String(error),
          );
        }
        return undefined;
      }
    })();
  }
  return modulePromise;
}

/** RDKit 是否可用（加载失败后返回 false）。 */
export async function isRdkitAvailable(): Promise<boolean> {
  return (await loadRdkitModule()) !== undefined;
}

/** 从 InChI 提取分子式段：InChI=1S/C9H8O4/c1-... → "C9H8O4"。 */
export function formulaFromInChI(inchi: string): string | undefined {
  const match = /^InChI=1S?\/([^/]+)/.exec(inchi);
  if (!match) return undefined;
  const formula = match[1];
  return formula.length > 0 ? formula : undefined;
}

/**
 * 分子式元素计数（SMILES 正则近似，仅 RDKit 不可用时兜底）。
 * 仅统计显式原子，不计算隐氢；Hill 序输出（C、H 优先，其余按字母序）。
 */
export function countElementsFromSmiles(smiles: string): string | undefined {
  const counts = new Map<string, number>();
  // 方括号原子：[Na+] / [NH4+] / [13CH3] / [Fe+2] → 取元素符号
  const bracketPattern = /\[(\d*)([A-Z][a-z]?)/g;
  // 有机子集原子（含芳环小写）：剔除方括号段后匹配，避免重复计数
  const plainPattern = /Cl|Br|[BCNOPSFI]|[bcnos]/g;
  let match: RegExpExecArray | null;
  while ((match = bracketPattern.exec(smiles)) !== null) {
    const element = match[2];
    counts.set(element, (counts.get(element) ?? 0) + 1);
  }
  const stripped = smiles.replace(/\[[^\]]*\]/g, " ");
  while ((match = plainPattern.exec(stripped)) !== null) {
    const element = match[0] === "Cl" || match[0] === "Br" ? match[0] : match[0].toUpperCase();
    counts.set(element, (counts.get(element) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const carbon = counts.get("C") ?? 0;
  const hydrogen = counts.get("H") ?? 0;
  const rest = [...counts.entries()]
    .filter(([element]) => element !== "C" && element !== "H")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([element, n]) => `${element}${n > 1 ? n : ""}`);
  const parts: string[] = [];
  if (carbon > 0) parts.push(`C${carbon > 1 ? carbon : ""}`);
  if (hydrogen > 0) parts.push(`H${hydrogen > 1 ? hydrogen : ""}`);
  parts.push(...rest);
  return parts.join("") || undefined;
}

/**
 * 语法级 SMILES 预检（RDKit 不可用时的降级校验，也用于候选预过滤）。
 * 仅做字符集与基本形态检查，不能证明结构合法。
 */
export function isPlausibleSmilesSyntax(value: string): boolean {
  const s = value.trim();
  if (s.length === 0 || s.length > 512) return false;
  if (!/^[A-Za-z0-9@+\-\\#=()\[\]\/%.]+$/.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  return true;
}

/**
 * 校验并规范化 SMILES。
 *
 * RDKit 可用：解析失败 → ok=false；成功 → ok=true（含规范化 SMILES/分子式/InChI）。
 * RDKit 不可用：语法预检通过 → ok=true + degraded=true（结构合法性未验证）；
 * 预检失败 → ok=false。
 */
export async function validateSmiles(smiles: string): Promise<SmilesValidationResult> {
  const value = smiles.trim();
  if (value.length === 0) return { ok: false, error: "空 SMILES" };
  // 评审 L2：超长输入直接拒绝——RDKit WASM 对超长/畸形输入可能抛出
  // memory access out of bounds（评审 H2 实测复现路径之一）
  if (value.length > 1024) return { ok: false, error: `SMILES 过长（${value.length} 字符，上限 1024）` };

  const rdkit = await loadRdkitModule();
  if (!rdkit) {
    return isPlausibleSmilesSyntax(value)
      ? { ok: true, degraded: true, error: "RDKit 不可用，仅通过语法预检（结构合法性未验证）" }
      : { ok: false, error: "SMILES 语法预检未通过" };
  }

  // 评审 H2：get_mol/get_smiles/get_inchi 对畸形输入（NUL 字节、复杂多环、
  // 近边界长度）可能抛 WASM 级异常——统一捕获归一为 ok=false，绝不外传
  let mol: JSMol | null = null;
  try {
    mol = rdkit.get_mol(value);
    if (!mol) return { ok: false, error: "RDKit 无法解析（结构非法）" };
    const canonicalSmiles = mol.get_smiles();
    const inchi = mol.get_inchi();
    let inchikey: string | undefined;
    try {
      inchikey = inchi ? rdkit.get_inchikey_for_inchi(inchi) : undefined;
    } catch {
      // InChIKey 计算失败不阻断（非关键字段）
    }
    const formula = inchi ? formulaFromInChI(inchi) : countElementsFromSmiles(canonicalSmiles);
    return { ok: true, canonicalSmiles, formula, inchi, inchikey };
  } catch (error) {
    return { ok: false, error: `RDKit 解析异常: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    mol?.delete();
  }
}
