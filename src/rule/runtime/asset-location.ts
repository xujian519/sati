/**
 * 宪法规则引擎 — 规则资产目录定位（共享 helper）。
 *
 * 统一 SATI_RULES_DIR → cwd/rules → 仓库根 rules 的定位策略，
 * 供 patent-compliance.ts / synonym-engine.ts / evidence/rule-loader.ts / rule-pack.ts 复用
 * （此前多处各自实现 candidateDirs，walk 次数 6/6/8 已发散，且 SATI_RULES_DIR 语义两套并存）。
 *
 * SATI_RULES_DIR 契约（唯一解释）：规则根目录，布局镜像仓库 `rules/`——
 *   平铺资产在 `<root>/patent/*.yaml`（compliance / synonyms / evidence-rules），
 *   规则包在 `<root>/<name>/` 与 `<root>/domains/<name>/`（base / mechanical / …）。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const PATENT_DIR = join("rules", "patent");
const MAX_WALK_LEVELS = 6;

/** 从 startDir 向上定位含 package.json 的根；找不到返回 startDir。 */
function walkUpForPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_LEVELS; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/** Sati 包根：从模块文件位置向上（随包分发的内置资产，如 rules/patent）。 */
function packageRoot(): string {
  return walkUpForPackageJson(CURRENT_DIR);
}

/** WorkSpace 根：从 cwd 向上（消费方项目根；项目规则包与清单 .sati/rules.yaml）。 */
export function findWorkspaceRoot(startDir = process.cwd()): string {
  return walkUpForPackageJson(startDir);
}

/** 候选规则目录（平铺资产，从最具体到最通用；walk 上限统一 6 层）。 */
export function candidateRuleDirs(): string[] {
  const candidates: string[] = [];
  const envDir = process.env.SATI_RULES_DIR;
  if (envDir) candidates.push(resolve(envDir, "patent"));
  candidates.push(resolve(process.cwd(), PATENT_DIR));
  candidates.push(join(packageRoot(), PATENT_DIR));
  return candidates;
}

/** 内置规则包候选目录（从最具体到最通用）：$SATI_RULES_DIR/<name> → cwd/rules/<name> → cwd/rules/domains/<name> → WorkSpace 根同名目录。 */
export function candidatePackDirs(name: string): string[] {
  const candidates: string[] = [];
  const envDir = process.env.SATI_RULES_DIR;
  if (envDir) candidates.push(resolve(envDir, name));
  const workspaceRoot = findWorkspaceRoot();
  candidates.push(resolve(process.cwd(), "rules", name));
  candidates.push(resolve(process.cwd(), "rules", "domains", name));
  candidates.push(join(workspaceRoot, "rules", name));
  candidates.push(join(workspaceRoot, "rules", "domains", name));
  return candidates;
}

/** 在候选目录中定位指定资产文件；未找到返回 null。 */
export function resolveRuleAsset(fileName: string): string | null {
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, fileName);
    if (existsSync(path)) return path;
  }
  return null;
}
