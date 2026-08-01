/**
 * 一次性迁移脚本：XiaoNuo Agent 专利规则 → Sati 宪法规则资产
 *
 * 双轨策略（用户确认）：
 *   1. 可执行转换：check.type 属于 Sati RuleLoader 支持的 4 种确定性检查
 *      （keyword_blocklist / pattern_analysis / structural_analysis / citation_analysis）
 *      → 转换为 Sati 格式写入 rules/patent/nuo-*.yaml（由 RuleLoader 加载生效）
 *   2. 原样资产：全部源规则文件（含 LLM 评估型 patent_novelty 等）原样复制到
 *      assets/patent-rules/（不经过 RuleLoader，供 agent/SKILL 作为参考知识）
 *
 * 语义映射（关键，已核对 XiaoNuo agent-core 引擎源码）：
 *   - XiaoNuo keyword_blocklist: 命中即违规（禁止语义）→ Sati keyword_blocklist ✅ 同义
 *   - XiaoNuo pattern_analysis: 任一 pattern 命中即通过（期望模式，缺失违规）
 *     → Sati structural_analysis 单 element（element.patterns 为 OR 语义，与之一致）
 *   - XiaoNuo structural_analysis: requiresAll 全部命中通过 → Sati structural_analysis ✅ 同义
 *   - 其余 check 类型（patent_novelty / patent_inventiveness 等）→ 不转换，归入原样资产
 *
 * 字段映射：ruleId→id、legal_basis→legalBasis、phases[0]→phase、
 *           severity: warning→major / info→minor / "error"→critical
 *
 * 用法：pnpm tsx scripts/port-nuo-rules.ts <nuo-rules-dir> [--dry-run]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify, parse } from "yaml";

const SUPPORTED_CHECK_TYPES = new Set([
  "keyword_blocklist",
  "pattern_analysis",
  "structural_analysis",
  "citation_analysis",
]);

const SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  major: "major",
  warning: "major", // Sati 无 warning，降为 major
  info: "minor",
  error: "critical",
};

function toSatiRule(raw: Record<string, unknown>): {
  rule: Record<string, unknown>;
  converted: boolean;
  note?: string;
} {
  const id = String(raw.ruleId ?? raw.id ?? "");
  if (!id) return { rule: raw, converted: false, note: "缺少 id/ruleId" };
  const name = String(raw.name ?? "");
  if (!name) return { rule: raw, converted: false, note: "缺少 name" };

  const checkRaw = raw.check as Record<string, unknown> | undefined;
  if (checkRaw === undefined || typeof checkRaw !== "object") {
    return { rule: raw, converted: false, note: "缺少 check" };
  }
  const checkType = String(checkRaw.type ?? "");
  if (!SUPPORTED_CHECK_TYPES.has(checkType)) {
    return { rule: raw, converted: false, note: `LLM 型 check: ${checkType}` };
  }

  const severityRaw = String(raw.severity ?? "warning");
  const severity = SEVERITY_MAP[severityRaw] ?? "major";
  const actionRaw = String(raw.action ?? "warn");
  const action = ["block", "warn", "review", "log"].includes(actionRaw) ? actionRaw : "warn";
  const phases = Array.isArray(raw.phases) ? (raw.phases as string[]) : [];
  const phase = phases.length > 0 ? phases.join("、") : typeof raw.phase === "string" ? raw.phase : undefined;

  let check: Record<string, unknown>;
  switch (checkType) {
    case "keyword_blocklist": {
      const keywords = (checkRaw.absoluteBan ?? checkRaw.keywords) as string[] | undefined;
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return { rule: raw, converted: false, note: "keyword_blocklist 缺 keywords/absoluteBan" };
      }
      check = {
        type: "keyword_blocklist",
        keywords,
        ...(checkRaw.negationContext === true ? { negationContext: true } : {}),
        ...(typeof checkRaw.severityIfFound === "string" ? { severityIfFound: checkRaw.severityIfFound } : {}),
      };
      break;
    }
    case "pattern_analysis": {
      // XiaoNuo 语义：任一 pattern 命中即通过（期望模式）→ Sati structural_analysis 单 element
      const patterns = checkRaw.patterns as string[] | undefined;
      if (!Array.isArray(patterns) || patterns.length === 0) {
        return { rule: raw, converted: false, note: "pattern_analysis 缺 patterns" };
      }
      check = {
        type: "structural_analysis",
        requiresAll: [{ element: "期望模式", description: name, patterns }],
        minConfidence: 1,
      };
      break;
    }
    case "structural_analysis": {
      const requiresAllRaw = (checkRaw.requiresAll ?? checkRaw.requires_all) as Record<string, unknown>[] | undefined;
      if (!Array.isArray(requiresAllRaw) || requiresAllRaw.length === 0) {
        return { rule: raw, converted: false, note: "structural_analysis 缺 requiresAll" };
      }
      const requiresAll = requiresAllRaw.map((elRaw, index) => ({
        element: String(elRaw.element ?? `要素${index + 1}`),
        ...(typeof elRaw.description === "string" ? { description: elRaw.description } : {}),
        patterns: (elRaw.patterns as string[]) ?? [],
      }));
      if (requiresAll.some(el => el.patterns.length === 0)) {
        return { rule: raw, converted: false, note: "structural_analysis 存在空 patterns" };
      }
      check = {
        type: "structural_analysis",
        requiresAll,
        ...(typeof checkRaw.minConfidence === "number" ? { minConfidence: checkRaw.minConfidence } : {}),
      };
      break;
    }
    case "citation_analysis": {
      const statutes = checkRaw.statutes as Record<string, unknown> | undefined;
      if (statutes === undefined || Object.keys(statutes).length === 0) {
        return { rule: raw, converted: false, note: "citation_analysis 缺 statutes" };
      }
      check = { type: "citation_analysis", statutes };
      break;
    }
    default:
      return { rule: raw, converted: false, note: `未知 check: ${checkType}` };
  }

  return {
    converted: true,
    rule: {
      id,
      name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
      ...(phase !== undefined ? { phase } : {}),
      severity,
      action,
      ...(typeof (raw.legalBasis ?? raw.legal_basis) === "string"
        ? { legalBasis: raw.legalBasis ?? raw.legal_basis }
        : {}),
      check,
    },
  };
}

function convertFile(filePath: string): { convertedRules: Record<string, unknown>[]; unconverted: string[] } {
  const text = readFileSync(filePath, "utf8");
  const doc = parse(text) as Record<string, unknown> | null;
  if (doc === null || !Array.isArray(doc.rules)) return { convertedRules: [], unconverted: [] };

  const convertedRules: Record<string, unknown>[] = [];
  const unconverted: string[] = [];
  for (const item of doc.rules) {
    const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { rule, converted, note } = toSatiRule(raw);
    if (converted) {
      convertedRules.push(rule);
    } else {
      unconverted.push(note ?? String(raw.id ?? raw.ruleId ?? "?"));
    }
  }
  return { convertedRules, unconverted };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const srcDirArg = args.find(a => !a.startsWith("--"));
  if (srcDirArg === undefined) {
    console.error("用法: pnpm tsx scripts/port-nuo-rules.ts <nuo-rules-dir> [--dry-run]");
    process.exit(1);
  }
  const srcDir = resolve(srcDirArg);
  if (!existsSync(srcDir)) {
    console.error(`源目录不存在: ${srcDir}`);
    process.exit(1);
  }

  const repoRoot = resolve(import.meta.dirname, "..");
  const rulesOutDir = join(repoRoot, "rules", "patent");
  const assetsOutDir = join(repoRoot, "assets", "patent-rules");

  const files = readdirSync(srcDir)
    .filter(f => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"))
    .sort();

  let totalConverted = 0;
  let totalUnconverted = 0;
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const srcPath = join(srcDir, file);
    const parsed = convertFile(srcPath);

    if (parsed.convertedRules.length > 0) {
      const outName = `nuo-${file}`;
      const yaml = stringify({
        version: "1.0",
        rules: parsed.convertedRules,
      });
      const header = [
        `# 由 scripts/port-nuo-rules.ts 从 XiaoNuo Agent ${file} 转换生成`,
        `# 原始文件完整内容见 assets/patent-rules/${file}（含 LLM 评估型规则与指导字段）`,
        `# 转换语义: pattern_analysis(期望模式)→structural_analysis 单 element；severity warning→major；info→minor`,
        "",
      ].join("\n");
      if (!dryRun) {
        mkdirSync(rulesOutDir, { recursive: true });
        writeFileSync(join(rulesOutDir, outName), header + yaml);
      }
      // id 冲突检测
      for (const rule of parsed.convertedRules) {
        const rid = String(rule.id);
        if (seenIds.has(rid)) {
          console.warn(`  ⚠️ 重复 id ${rid}: ${seenIds.get(rid)} 与 ${file}`);
        } else {
          seenIds.set(rid, file);
        }
      }
      totalConverted += parsed.convertedRules.length;
      console.log(`✓ ${file}: 转换 ${parsed.convertedRules.length} 条 → rules/patent/${outName}`);
    }

    if (parsed.unconverted.length > 0) {
      totalUnconverted += parsed.unconverted.length;
      console.log(
        `  → ${file} 中 ${parsed.unconverted.length} 条 LLM 型规则（如 ${parsed.unconverted.slice(0, 3).join(", ")}…）归入原样资产`,
      );
    }

    if (!dryRun) {
      mkdirSync(assetsOutDir, { recursive: true });
      copyFileSync(srcPath, join(assetsOutDir, file));
    }
  }

  // 递归复制 articles/ 与 orchestrations/ 子目录
  for (const sub of ["articles", "orchestrations"]) {
    const subPath = join(srcDir, sub);
    if (!existsSync(subPath)) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = full.slice(srcDir.length + 1);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (!dryRun) {
          mkdirSync(join(assetsOutDir, dirname(rel)), { recursive: true });
          copyFileSync(full, join(assetsOutDir, rel));
        }
      }
    };
    walk(subPath);
    console.log(`✓ 复制 ${sub}/ 目录 → assets/patent-rules/${sub}/`);
  }

  console.log(`\n汇总: 转换 ${totalConverted} 条可执行规则，${totalUnconverted} 条 LLM 型规则归入原样资产`);
  console.log(`输出: rules/patent/nuo-*.yaml + assets/patent-rules/（${dryRun ? "DRY RUN 未写入" : "已写入"}）`);
}

function dirname(p: string): string {
  return p.split(/[\\/]/).slice(0, -1).join("/");
}

main();
