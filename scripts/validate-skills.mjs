// Validate every built-in skill under <repo>/skills against SkillManager's rules.
// Usage: node scripts/validate-skills.mjs [path]
// Exit code 0 = all skills valid, 1 = hard failures, 2 = warnings only.
// Mirrors src/extension/skills/SkillManager.ts: SLUG_RE, frontmatter name/description
// requirements, size caps (10MB/file, 50MB total, 500 files), <500-line guidance.
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 500;

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function walk(root, prefix, stats, issues) {
  let entries;
  try {
    entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (stats.fileCount > MAX_FILE_COUNT) return;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, rel, stats, issues);
      continue;
    }
    stats.fileCount += 1;
    const full = join(root, rel);
    let size = 0;
    try {
      size = (await fs.stat(full)).size;
    } catch {
      continue;
    }
    stats.totalBytes += size;
    if (size > MAX_FILE_BYTES) issues.push(`hard: ${rel} exceeds 10MB (${size} bytes)`);
  }
}

async function validateSkill(skillDir) {
  const slug = basename(skillDir);
  const issues = [];
  if (!SLUG_RE.test(slug) || slug.includes("..")) {
    issues.push(`hard: invalid slug "${slug}"`);
  }
  let content = "";
  try {
    content = await fs.readFile(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return { slug, issues: [`hard: missing SKILL.md in ${slug}`] };
  }
  const fm = parseFrontmatter(content);
  if (!content.startsWith("---")) {
    issues.push(`hard: ${slug} does not start with a YAML frontmatter block`);
  }
  if (typeof fm.name !== "string" || !fm.name.trim()) {
    issues.push(`hard: ${slug} frontmatter missing required field: name`);
  }
  const desc = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!desc) {
    issues.push(`hard: ${slug} frontmatter missing required field: description`);
  } else {
    if (desc.length < 20) issues.push(`warn: ${slug} description is short (${desc.length} chars)`);
    if (desc.length > 1024) issues.push(`warn: ${slug} description is very long (${desc.length} chars)`);
  }
  const lineCount = content.split("\n").length;
  if (lineCount > 500) issues.push(`warn: ${slug} SKILL.md is ${lineCount} lines (>500 guidance)`);

  // HTML 模板元数据校验（可选）：mode/scenario/surface 未知时 warn；preview 文件缺失时 hard。
  if (fm.mode || fm.scenario || fm.surface || fm.preview || fm.design_system) {
    const enums = [
      ["mode", new Set(["doc", "deck", "data-report", "poster", "social-card", "prototype", "office", "frame"])],
      ["scenario", new Set(["patent", "legal", "finance", "product", "operation", "design", "personal"])],
      ["surface", new Set(["long-page", "a4", "16:9", "1600x900", "1080x1920", "auto"])],
    ];
    for (const [key, allowed] of enums) {
      const value = fm[key];
      if (typeof value === "string" && !allowed.has(value)) {
        issues.push(`warn: ${slug} ${key} "${value}" is not in the known enum`);
      }
    }
    if (typeof fm.preview === "string" && fm.preview.trim()) {
      const previewPath = join(skillDir, fm.preview);
      try {
        const previewStat = await fs.stat(previewPath);
        if (!previewStat.isFile()) {
          issues.push(`hard: ${slug} preview "${fm.preview}" is not a file`);
        }
      } catch {
        issues.push(`hard: ${slug} preview file missing: ${fm.preview}`);
      }
    }
  }

  // Wiki 卡片路径校验：反引号内以 wiki 顶层目录（如 专利实务/复审无效）开头的相对路径
  // 须能在 src/knowledge/patent/wiki/ 下解析到 .md，防止技能文档引用漂移。
  // 顶层目录从 wiki 目录动态读取；目录不存在（如按自定义路径运行）时跳过本检查。
  const wikiRoot = resolve("src/knowledge/patent/wiki");
  const wikiTops = new Set();
  try {
    const entries = await fs.readdir(wikiRoot, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory()) wikiTops.add(entry.name);
  } catch {
    // 非仓库根目录运行时 wiki 目录不可达，跳过
  }
  if (wikiTops.size > 0) {
    const seen = new Set();
    for (const match of content.matchAll(/`([^`\n]+)`/g)) {
      const ref = match[1].trim();
      if (!ref.includes("/") || ref.includes("*")) continue; // 非相对路径 / glob 通配跳过
      if (!wikiTops.has(ref.split("/")[0])) continue; // 非 wiki 顶层目录开头（如 references/、src/）跳过
      const rel = ref.endsWith(".md") ? ref : `${ref}.md`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      try {
        await fs.access(join(wikiRoot, rel));
      } catch {
        issues.push(`hard: ${slug} SKILL.md references missing wiki card: ${ref}`);
      }
    }
  }

  const stats = { fileCount: 0, totalBytes: 0 };
  await walk(skillDir, "", stats, issues);
  if (stats.fileCount > MAX_FILE_COUNT) issues.push(`hard: ${slug} has >${MAX_FILE_COUNT} files`);
  if (stats.totalBytes > MAX_TOTAL_BYTES) issues.push(`hard: ${slug} total size exceeds 50MB`);

  // 知识接线校验：专利/法律职责技能（slug 以 patent-/legal- 开头，或顶层 domains 含 patent/legal）
  // 除纯工具/外部数据类豁免外，应至少引用一个知识系统工具（patent_wiki_search / patent_case_search /
  // law_search），防止技能文本完全脱离项目知识系统（knowledge.db）。warn 级（不阻断）。
  const KNOWLEDGE_TOOLS = ["patent_wiki_search", "patent_case_search", "law_search"];
  // 纯工具/外部数据类技能不依赖知识系统，豁免。
  const KNOWLEDGE_EXEMPT = new Set([
    "patent-download",
    "patent-search",
    "cnipa-query",
    "google-patents-search",
    "academic-search",
    "chemical-structure-recognition",
  ]);
  const roleDomains = Array.isArray(fm.domains) ? fm.domains : [];
  const isPatentLegalSkill =
    /^patent-|^legal-/.test(slug) || roleDomains.includes("patent") || roleDomains.includes("legal");
  if (isPatentLegalSkill && !KNOWLEDGE_EXEMPT.has(slug)) {
    const hasWiring = KNOWLEDGE_TOOLS.some(tool => content.includes(tool));
    if (!hasWiring) {
      issues.push(
        `warn: ${slug} is a patent/legal skill but lacks knowledge-system wiring ` +
          `(none of ${KNOWLEDGE_TOOLS.join(" / ")})`,
      );
    }
  }

  // 角色 frontmatter 一致性（type: role → 顶层 tools/domains/omitTools/readOnly/systemPrompt）。
  if (fm.type === "role") {
    if (!Array.isArray(fm.domains) || fm.domains.length === 0) {
      issues.push(`hard: ${slug} is a role but has no domains array`);
    }
    if (!(Array.isArray(fm.tools) || fm.tools === "*")) {
      issues.push(`hard: ${slug} is a role but has no tools array (or "*")`);
    }
    if (fm.omitTools !== undefined && !Array.isArray(fm.omitTools)) {
      issues.push(`hard: ${slug} omitTools must be an array`);
    }
    if (fm.readOnly !== undefined && typeof fm.readOnly !== "boolean") {
      issues.push(`hard: ${slug} readOnly must be a boolean`);
    }
    if (fm.systemPrompt !== undefined && typeof fm.systemPrompt !== "string") {
      issues.push(`hard: ${slug} systemPrompt must be a string`);
    }
  }

  // 无版本化措辞（作者时校验：SKILL.md 面向模型，不应出现版本营销文案）。
  // 仅匹配明确的营销短语，避免误伤合法内容（如第三方工具版本号、changelog 分类名）。
  const versionTalk = /\b(now adds|newly added|this release|upgrade[ds]? from)\b/i;
  if (versionTalk.test(content)) {
    issues.push(`warn: ${slug} SKILL.md contains version-talk wording`);
  }

  // 同族角色 spine 契约（warn 级，宽松）：patent/provision 角色既无 "## " 章节、
  // 也无实质 systemPrompt（即完全未组织），才视为未组织。避免对多样化章节标题
  // 与把工作流放在 systemPrompt 的角色过度约束。
  if (fm.type === "role" && (/^patent-|^provision-/.test(slug) || roleDomains.includes("patent"))) {
    const hasBodySections = /^##\s+/m.test(content);
    const hasSystemPrompt = typeof fm.systemPrompt === "string" && fm.systemPrompt.trim().length > 20;
    if (!hasBodySections && !hasSystemPrompt) {
      issues.push(`warn: ${slug} is a patent family role but has no structured body or systemPrompt`);
    }
  }
  return { slug, issues, lineCount };
}

async function main() {
  const root = resolve(process.argv[2] ?? "skills");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read skills root: ${root} (${err.code})`);
    process.exit(1);
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    results.push(await validateSkill(join(root, entry.name)));
  }
  const allIssues = results.flatMap(r => r.issues.map(i => `${r.slug}: ${i}`));
  const hards = allIssues.filter(i => i.includes("hard:"));
  const warns = allIssues.filter(i => i.includes("warn:"));
  console.log(`Checked ${results.length} skills under ${root}`);
  for (const r of results) console.log(`  ${r.slug} (${r.lineCount} lines)`);
  if (warns.length) {
    console.log(`\nWarnings (${warns.length}):`);
    for (const w of warns) console.log(`  ${w}`);
  }
  if (hards.length) {
    console.log(`\nHard failures (${hards.length}):`);
    for (const h of hards) console.log(`  ${h}`);
    process.exit(1);
  }
  if (warns.length) process.exit(2);
  console.log("\nAll skills valid.");
}

main();
