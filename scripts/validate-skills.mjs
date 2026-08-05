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
