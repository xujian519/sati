/**
 * 宪法规则引擎 — 规则资产目录定位（共享 helper）。
 *
 * 统一 SATI_RULES_DIR → cwd/rules/patent → 仓库根 rules/patent 的定位策略，
 * 供 patent-compliance.ts / synonym-engine.ts / evidence/rule-loader.ts 复用
 * （此前三处各自实现 candidateDirs，walk 次数 6/6/8 已发散）。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** 候选规则目录（从最具体到最通用；walk 上限统一 6 层）。 */
export function candidateRuleDirs(): string[] {
  const candidates: string[] = [];
  const envDir = process.env.SATI_RULES_DIR;
  if (envDir) candidates.push(resolve(envDir));
  candidates.push(resolve(process.cwd(), "rules", "patent"));
  // 仓库根：从本文件位置向上找到 package.json
  let dir = CURRENT_DIR;
  for (let i = 0; i < 6; i += 1) {
    dir = dirname(dir);
    if (existsSync(join(dir, "package.json"))) {
      candidates.push(join(dir, "rules", "patent"));
      break;
    }
  }
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
