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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// 权威清单提取
// ---------------------------------------------------------------------------

/** 递归收集目录下所有匹配后缀的文件。 */
function collectFiles(dir, suffix) {
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

/** 提取工具注册名：src/tool/builtin/*.ts 与 law-search-tool.ts 的 name: "…"。 */
function collectToolNames() {
  const files = [
    ...collectFiles(join(SRC_ROOT, "tool", "builtin"), ".ts"),
    join(SRC_ROOT, "knowledge", "legal", "law-search-tool.ts"),
  ];
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/name:\s*"([a-z][a-z0-9_]{1,60})"/g)) {
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

/** cap01 手册中全部 `code` 标识符（小写开头，字母/数字/下划线/连字符）。 */
function collectManualRefs() {
  const text = readFileSync(join(REPO_ROOT, "assets", "prompts", "patent", "cap01-orchestrator.md"), "utf8");
  const refs = new Set();
  for (const m of text.matchAll(/`([a-z][a-z0-9_-]{1,60})`/g)) {
    refs.add(m[1]);
  }
  return refs;
}

/** workflow YAML 的 worker 字段引用。 */
function collectYamlWorkers() {
  const dir = join(REPO_ROOT, "assets", "workflows", "patent");
  const refs = new Set();
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
  "provision_disclosure",
  "provision-disclosure",
  "provision_drafting_claims",
  "provision-drafting-claims",
  "provision_drafting_spec",
  "provision-drafting-spec",
  "provision_novelty",
  "provision-novelty",
  "provision_inventiveness",
  "provision-inventiveness",
  "provision_utility",
  "provision-utility",
  "provision_eligibility",
  "provision-eligibility",
  "provision_claims_clarity",
  "provision-claims-clarity",
  "provision_amendment",
  "provision-amendment",
  "provision_prior_art",
  "provision-prior-art",
  "provision_infringement_literal",
  "provision-infringement-literal",
  "provision_infringement_equivalent",
  "provision-infringement-equivalent",
  "provision_unity",
  "provision-unity",
  "provision_design_auth",
  "provision-design-auth",
  "provision_claim_construction",
  "provision-claim-construction",
  "provision_indirect_infringement",
  "provision-indirect-infringement",
  "provision_defenses",
  "provision-defenses",
  "provision_damages",
  "provision-damages",
  "provision_ownership",
  "provision-ownership",
  "provision_invalidity_procedure",
  "provision-invalidity-procedure",
  "provision_reexamination",
  "provision-reexamination",
  "provision_priority",
  "provision-priority",
  "domain", // 前缀引用（domain-{IPC}-novelty 等）
  "reasoning", // 前缀引用（reasoning-*）
  "checker", // 前缀引用（checker 角色族）
  "provision", // 前缀引用（provision-*）
  "worker", // 文档措辞
  // 规划中的 orchestrator 角色（无 SKILL.md，见 cap01 头注）
  "patent_orchestrator",
  "patent-orchestrator",
]);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const toolNames = collectToolNames();
const subagentTypes = collectSubagentTypes();
const workers = collectWorkers();
const manifestIds = collectManifestIds();
const atomNames = collectAtomNames();

const missing = [];
const classify = ref => {
  if (toolNames.has(ref)) return "tool";
  if (subagentTypes.has(ref)) return "subagent_type";
  if (workers.has(ref)) return "worker";
  if (manifestIds.has(ref)) return "manifest";
  if (atomNames.has(ref)) return "atom";
  return undefined;
};

for (const ref of collectManualRefs()) {
  if (classify(ref) === undefined && !ALLOWLIST.has(ref)) {
    missing.push(`cap01-orchestrator.md: 未知引用 "${ref}"（工具/角色/worker 均未命中，白名单未覆盖）`);
  }
}
for (const ref of collectYamlWorkers()) {
  if (classify(ref) === undefined && !ALLOWLIST.has(ref)) {
    missing.push(`workflow yaml: 未知 worker "${ref}"`);
  }
}

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
  `check-patent-sop-references: fresh（tools=${toolNames.size}, subagent_types=${subagentTypes.size}, workers=${workers.size}）`,
);
