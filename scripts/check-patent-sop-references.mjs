#!/usr/bin/env node
// check-patent-sop-references.mjs
// 专利 SOP 引用完整性门禁：校验 cap01 编排手册与 patent workflow YAML 引用的
// 工具 / subagent_type / worker 在代码中真实存在，防"纸面 SOP 与代码脱节"回潮。
//
// 背景（2026-08）：审计发现 cap01-orchestrator.md 引用 6 个不存在的工具
// （plan_workflow/list_workers/suggest_checkers/run_checker_review/run_patent_rules/
// list_checkers）、7 个未注册 worker（project-probe/rule-explorer 等），且
// subagent_type 命名与注册名双轨（technical_analyzer vs patent-analyzer）。
// 迭代二 T5/T7 已处理命名与手册；本脚本把"引用必须真实存在"固化为门禁。
//
// 校验数据源：
//  - assets/prompts/patent/cap01-orchestrator.md（全部 `code` 标识符）
//  - assets/workflows/patent/*.yaml（worker: 字段）
// 权威清单（静态文本提取，不依赖 TS 解析）：
//  - 工具：src/tool/builtin/*.ts + src/knowledge/legal/law-search-tool.ts 的 name: "…"
//  - subagent_type：内置 4 个 + skills/*/SKILL.md（type: role）的 name + 别名键
//  - worker：src/patent/worker-contract.ts defaultPatentWorkers 的 name
// 白名单：文档性/规划性引用（字段名、外部 CLI、规划中的 worker/角色）。
//
// 挂载：根 package.json lint 脚本末尾（与 check:event-matrix 同处）。
// 用法：node scripts/check-patent-sop-references.mjs

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_ARG_INDEX = process.argv.indexOf("--root");
const REPO_ROOT = ROOT_ARG_INDEX >= 0 ? resolve(process.argv[ROOT_ARG_INDEX + 1]) : DEFAULT_ROOT;
const SRC_ROOT = join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// 权威清单提取
// ---------------------------------------------------------------------------

/** 递归收集目录下所有匹配后缀的文件。 */
function collectFiles(dir, suffix) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, suffix));
    } else if (entry.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/** 提取工具注册名：builtin / literature / legal 的 name: "…" 与 *_TOOL_NAME 常量。 */
function collectToolNames() {
  const files = [
    ...collectFiles(join(SRC_ROOT, "tool", "builtin"), ".ts"),
    ...collectFiles(join(SRC_ROOT, "literature", "tool"), ".ts"),
    ...collectFiles(join(SRC_ROOT, "knowledge", "legal"), ".ts"),
  ];
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/name:\s*"([a-z][a-z0-9_]{1,60})"/g)) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(/TOOL_NAME\s*=\s*"([a-z][a-z0-9_]{1,60})"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** 提取 subagent_type：内置 4 个 + skills type:role 角色名 + agent.ts 别名键。 */
function collectSubagentTypes() {
  const types = new Set(["general-purpose", "explore", "plan", "verify"]);
  const skillsDir = join(REPO_ROOT, "skills");
  for (const file of collectFiles(skillsDir, "SKILL.md")) {
    const text = readFileSync(file, "utf8");
    if (!/type:\s*role/.test(text)) continue;
    const name = text.match(/^name:\s*([a-z][a-z0-9-]*)$/m);
    if (name) types.add(name[1]);
  }
  // 别名键（agent.ts SUBAGENT_TYPE_ALIASES，与 T5 映射表同步）。
  const agentTs = readFileSync(join(SRC_ROOT, "tool", "builtin", "agent.ts"), "utf8");
  for (const m of agentTs.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*"patent-[a-z-]+",$/gm)) {
    types.add(m[1]);
  }
  return types;
}

/** 提取 worker：defaultPatentWorkers 目录（worker-contract.ts 的 name: "…"）。 */
function collectWorkers() {
  const text = readFileSync(join(SRC_ROOT, "patent", "worker-contract.ts"), "utf8");
  const names = new Set();
  for (const m of text.matchAll(/^\s+name:\s*"([a-z][a-z0-9_-]*)",$/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** 提取内置 manifest id（manifests.ts 的 id: "patent_*_vN"）。 */
function collectManifestIds() {
  const text = readFileSync(join(SRC_ROOT, "patent", "workflow", "manifests.ts"), "utf8");
  const ids = new Set();
  for (const m of text.matchAll(/^\s{2}id:\s*"(patent_[a-z][a-z0-9_]*_v\d+)",$/gm)) {
    ids.add(m[1]);
  }
  return ids;
}

/** 提取 Pipeline 原子名（atoms/handlers/builtin/*.ts 的 name: "…"，允许连字符）。 */
function collectAtomNames() {
  const files = collectFiles(join(SRC_ROOT, "patent", "atoms", "handlers", "builtin"), ".ts");
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/name:\s*"([a-z][a-z0-9-]{1,60})"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 引用提取
// ---------------------------------------------------------------------------

/**
 * 文档中的工具形引用：反引号内、至少含一个下划线的 snake_case token。
 * 扫描面：patent 提示词、全部 SKILL.md、规则文档（#714 起从 cap01 单点扩面）。
 */
const TOOL_IDENTIFIER_RE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

export function collectToolIdentifiers(markdown) {
  const refs = [];
  for (const m of markdown.matchAll(TOOL_IDENTIFIER_RE)) {
    refs.push(m[1]);
  }
  return refs;
}

/** 收集全部文档引用（带文件:行，便于定位）。 */
function collectMarkdownRefs() {
  const files = [
    ...collectFiles(join(REPO_ROOT, "assets", "prompts", "patent"), ".md"),
    ...collectFiles(join(REPO_ROOT, "skills"), "SKILL.md"),
    ...collectFiles(join(REPO_ROOT, "rules"), ".md"),
  ];
  const refs = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(TOOL_IDENTIFIER_RE)) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      refs.push({ ref: m[1], location: `${relativeToRoot(file)}:${line}` });
    }
  }
  return refs;
}

function relativeToRoot(file) {
  return file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file;
}

/** workflow YAML 的 worker 字段引用。 */
function collectYamlWorkers() {
  const dir = join(REPO_ROOT, "assets", "workflows", "patent");
  const refs = new Set();
  if (!existsSync(dir)) return refs;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".yaml"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/^\s*worker:\s*([a-z][a-z0-9_-]*)/gm)) {
      refs.add(m[1]);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 白名单：文档性/规划性引用（字段名、外部 CLI、迭代二/三规划中的 worker/角色）。
// 幽灵工具（plan_workflow 等）在 T7 手册修订后不应再出现于手册——届时可移出白名单。
// ---------------------------------------------------------------------------

const ALLOWLIST = new Set([
  // 通用字段名/文档措辞（非工具）
  "subagent_type",
  "subagentType",
  "provision_ids",
  "reasoningPatterns",
  "ipc_hints",
  "template_id",
  "case_id",
  "caseId",
  "outputs",
  "decisions", // sati.md 段名
  "pass", // CAP09 verdict 值
  "needs_revision", // CAP09 verdict 值
  "blocked", // CAP09 verdict 值
  "artifact-quality-check", // 质量阶段名（§4 DAG）
  // 意图路由 template_id（YAML 模板 id，非工具）
  "office-action-response",
  "infringement-analysis",
  "invalidation-response",
  "prosecution-draft",
  "prior-art-survey",
  // 简写工具名（T7 手册已修订为真实名 read_file/edit_file/write_file；条目保留仅防回潮）
  "read",
  "edit",
  "write",
  // 外部 CLI / 浏览器 / 描述性引用
  "markitdown",
  "webfetch",
  "ego_browser",
  "ego_lite",
  // reasoning-* 推理 worker（规划中，见 cap01 §3.3）
  "reasoning-prior-art-identification",
  "reasoning-disclosure-type",
  "reasoning-obviousness-effect",
  "reasoning-enablement",
  "reasoning-claim-unsupported",
  "reasoning-subject-matter",
  "reasoning-equivalent-infringement",
  "reasoning-conflicting-application",
  "reasoning-routine-selection",
  "reasoning-claim-unclear",
  "reasoning-functional-limitation",
  "reasoning-experimental-data",
  "reasoning-amendment-priority",
  "reasoning-design-space",
  // domain-* 域后缀（§3.4：domain-{IPC段}-{后缀}）
  "novelty",
  "inventiveness",
  "disclosure",
  "claims-clarity",
  // 规划中的 worker（迭代二/三补齐，见 docs/patent-drafting-sop-plan.md）
  "project_probe",
  "project-probe",
  "rule_explorer",
  "rule-explorer",
  "patent_search_planner",
  "patent-search-planner",
  "patent_search_executor",
  "patent-search-executor",
  "patent_downloader",
  "patent-downloader",
  "patent_oa_response_drafter",
  "patent-oa-response-drafter",
  "patent_slop_cleaner",
  "patent-slop-cleaner",
  "bcip_retrieval",
  "bcip-retrieval",
  "domain", // 前缀引用（domain-{IPC}-novelty 等）
  "reasoning", // 前缀引用（reasoning-*）
  "checker", // 前缀引用（checker 角色族）
  "provision", // 前缀引用（provision-*）
  "worker", // 文档措辞
  // 规划中的 orchestrator 角色（无 SKILL.md，见 cap01 头注）
  "patent_orchestrator",
  "patent-orchestrator",
  // 提示词输入变量 / 输出字段（非工具，扫描扩面后登记）
  "legal_basis",
  "claim_text",
  "prior_art_context",
  "technical_field",
  "examiner_rejection",
  "image_path",
  "claim_context",
  "figure_analysis",
  "review_pending",
  "finalize_ready",
  "escalate_human",
  "set_gaps",
  "recall_check",
  "refine_query",
  "citation_gate",
  // 工具参数 / 运行配置 / 技能元数据字段
  "max_turns",
  "max_tool_calls",
  "timeout_ms",
  "total_tokens",
  "duration_ms",
  "without_skill",
  "best_description",
  "available_skills",
  "figure_count",
  "figure_no",
  "svg_paths",
  "at_mm",
  "label_offset_mm",
  // 规则引擎的 check.type / 阶段名 / 领域名（非工具）
  "keyword_blocklist",
  "pattern_analysis",
  "structural_analysis",
  "citation_analysis",
  "fix_suggestion",
  "pre_execution",
  "post_execution",
  "approval_pending",
  "patent_novelty",
  "patent_inventiveness",
  // workflow 阶段 id（非工具）
  "figure_generate",
  // 第三方站点工具 / 环境变量 / 平台字段
  "get_patent_metadata",
  "present_files",
  "https_proxy",
  "http_proxy",
  "in_trash",
  "meeting_notes",
  "data_source_id",
]);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const toolNames = collectToolNames();
  const subagentTypes = collectSubagentTypes();
  const workers = collectWorkers();
  const manifestIds = collectManifestIds();
  const atomNames = collectAtomNames();

  /** 已知幽灵引用的建议替代项（只用于报错提示，不参与放行判定）。 */
  const REFERENCE_SUGGESTIONS = {
    patent_kg_search: "patent_kg_query",
    patent_kg_path: "patent_kg_query",
    patent_rag: "law_search / law_verify",
    patent_law: "law_search / law_verify",
    get_patent_metadata: "patent_metadata",
    figure_generate: "patent_figure_generate",
  };

  const suggestionFor = ref => {
    const exact = REFERENCE_SUGGESTIONS[ref];
    if (exact) return `（疑似替代：${exact}）`;
    const prefix = ref.slice(0, ref.lastIndexOf("_") + 1);
    const sameFamily = [...toolNames].filter(name => name.startsWith(prefix));
    return sameFamily.length > 0 ? `（同前缀工具：${sameFamily.slice(0, 3).join(", ")}）` : "";
  };

  const missing = [];
  const classify = ref => {
    if (toolNames.has(ref)) return "tool";
    if (subagentTypes.has(ref)) return "subagent_type";
    if (workers.has(ref)) return "worker";
    if (manifestIds.has(ref)) return "manifest";
    if (atomNames.has(ref)) return "atom";
    return undefined;
  };

  for (const { ref, location } of collectMarkdownRefs()) {
    if (classify(ref) === undefined && !ALLOWLIST.has(ref)) {
      missing.push(`${location}: 未知引用 "${ref}"（工具/角色/worker 均未命中，白名单未覆盖）${suggestionFor(ref)}`);
    }
  }
  for (const ref of collectYamlWorkers()) {
    if (classify(ref) === undefined && !ALLOWLIST.has(ref)) {
      missing.push(`workflow yaml: 未知 worker "${ref}"`);
    }
  }
  return { missing, counts: { tools: toolNames.size, subagentTypes: subagentTypes.size, workers: workers.size } };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { missing, counts } = main();
  if (missing.length > 0) {
    console.error(`check-patent-sop-references: ${missing.length} 处引用未在代码中登记：`);
    for (const line of missing) console.error(`  - ${line}`);
    console.error(
      "处理方式：① 真实存在的引用加入权威清单提取（工具 name/角色 SKILL.md/worker 契约）；" +
        "② 规划中的引用加入白名单并注明迭代；③ 幽灵引用应删除而非入白名单。",
    );
    process.exit(1);
  }
  console.log(
    `check-patent-sop-references: fresh（tools=${counts.tools}, subagent_types=${counts.subagentTypes}, workers=${counts.workers}）`,
  );
}
