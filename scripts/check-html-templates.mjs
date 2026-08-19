#!/usr/bin/env node
// check-html-templates.mjs
// 校验 Sati 的 HTML 交付技能模板是否满足共享契约：
// - 每个 html-* 模板必须包含 SKILL.md / example.html / references/checklist.md
// - 借鉴来源必须有 references/SOURCE.md 或 LICENSE
// - SKILL.md 必须引用 assets/prompts/html/shared-design-directives.md
// - example.html 必须为单文件 HTML，无占位符/本地图片，包含 CJK 字体栈
//
// 用法：
//   node scripts/check-html-templates.mjs                # 扫描 skills/ 下所有 HTML 模板
//   node scripts/check-html-templates.mjs <file.html>    # 单文件模式
//
// 退出码：0 通过；1 hard 失败；2 仅 warning。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(REPO_ROOT, "skills");
const SHARED_DIRECTIVES = "assets/prompts/html/shared-design-directives.md";
const MAX_EXAMPLE_BYTES = 5 * 1024 * 1024;

const PLACEHOLDER_PATTERNS = [
  /lorem\s+ipsum/i,
  /Your text here/i,
  /TODO\s*:/,
  /TODO（/,
  /此处填[写入]?/,
  /〔?占位[符文]?/,
];

function hard(issues, message) {
  issues.push(`hard: ${message}`);
}

function warn(issues, message) {
  issues.push(`warn: ${message}`);
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  const fm = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return fm;
}

function isHtmlTemplateDir(dir) {
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) return false;
  const content = readFileSync(skillPath, "utf8");
  const fm = parseFrontmatter(content);
  return basename(dir).startsWith("html-") || Boolean(fm.mode);
}

function checkHtmlFile(htmlPath, issues) {
  if (!existsSync(htmlPath)) {
    hard(issues, `missing example.html: ${htmlPath}`);
    return;
  }
  const html = readFileSync(htmlPath, "utf8");
  const trimmed = html.trim();
  if (!trimmed.startsWith("<!DOCTYPE html") && !trimmed.startsWith("<!doctype html")) {
    hard(issues, `${htmlPath} must start with <!DOCTYPE html>`);
  }
  if (!html.includes("</html>")) {
    hard(issues, `${htmlPath} must end with </html>`);
  }
  if (!/<html[^>]*\blang=["']?[A-Za-z-]+/i.test(html)) {
    warn(issues, `${htmlPath} should declare a lang attribute`);
  }
  if (!/(Noto\s+Sans\s+SC|Noto\s+Serif\s+SC|Source\s+Han\s+Sans|Source\s+Han\s+Serif)/.test(html)) {
    hard(issues, `${htmlPath} must include a CJK font stack`);
  }
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(html)) {
      hard(issues, `${htmlPath} contains placeholder text matching ${pattern}`);
    }
  }
  if (
    /src\s*=\s*["']\.{0,2}\/[^"']*\.(png|jpe?g|gif|webp|svg)/i.test(html) ||
    /src\s*=\s*["'](?:images?|assets|static)\//i.test(html)
  ) {
    hard(issues, `${htmlPath} must not reference local images`);
  }
  const size = statSync(htmlPath).size;
  if (size > MAX_EXAMPLE_BYTES) {
    hard(issues, `${htmlPath} exceeds 5MB (${size} bytes)`);
  }
}

function checkTemplateDir(dir) {
  const slug = basename(dir);
  const issues = [];
  const skillPath = join(dir, "SKILL.md");
  const examplePath = join(dir, "example.html");
  const checklistPath = join(dir, "references", "checklist.md");
  const sourcePath = join(dir, "references", "SOURCE.md");
  const licensePath = join(dir, "LICENSE");

  if (!existsSync(skillPath)) {
    hard(issues, `${slug}/SKILL.md missing`);
    return { slug, issues };
  }
  const skill = readFileSync(skillPath, "utf8");
  const fm = parseFrontmatter(skill);
  if (!fm.name || !fm.description) {
    hard(issues, `${slug}/SKILL.md frontmatter missing name or description`);
  }
  if (!skill.includes(SHARED_DIRECTIVES)) {
    hard(issues, `${slug}/SKILL.md must reference ${SHARED_DIRECTIVES}`);
  }
  if (!existsSync(examplePath)) {
    hard(issues, `${slug}/example.html missing`);
  } else {
    checkHtmlFile(examplePath, issues);
  }
  if (!existsSync(checklistPath)) {
    hard(issues, `${slug}/references/checklist.md missing`);
  }
  if (!existsSync(sourcePath) && !existsSync(licensePath)) {
    warn(issues, `${slug} should include references/SOURCE.md or LICENSE for attribution`);
  }
  return { slug, issues };
}

/** 打印问题并按 hard/warn 分类；退出码由调用方决定。 */
function report(title, issues) {
  const hards = issues.filter(i => i.includes("hard:"));
  const warns = issues.filter(i => i.includes("warn:"));
  console.log(title);
  for (const w of warns) console.log(`  ${w}`);
  for (const h of hards) console.log(`  ${h}`);
  return { hards, warns };
}

function main() {
  const target = process.argv[2];
  let skillsRoot = SKILLS_DIR;

  if (target === "--dir") {
    skillsRoot = resolve(process.argv[3] ?? SKILLS_DIR);
  } else if (target && (extname(target) === ".html" || existsSync(target))) {
    const abs = resolve(target);
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      console.error("Not an HTML file:", target);
      process.exit(1);
    }
    const issues = [];
    checkHtmlFile(abs, issues);
    const { hards, warns } = report(`Checked 1 HTML file: ${abs}`, issues);
    if (hards.length) process.exit(1);
    console.log(warns.length ? "HTML file passed with warnings." : "HTML file passed.");
    return;
  }

  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    console.error(`Cannot read skills dir: ${skillsRoot}`);
    process.exit(1);
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsRoot, entry.name);
    if (!isHtmlTemplateDir(dir)) continue;
    results.push(checkTemplateDir(dir));
  }
  if (results.length === 0) {
    console.log("No HTML template skills found.");
    process.exit(0);
  }
  const allIssues = results.flatMap(r => r.issues.map(i => `${r.slug}: ${i}`));
  const { hards, warns } = report(`Checked ${results.length} html templates`, allIssues);
  if (hards.length) process.exit(1);
  if (warns.length) process.exit(2);
  console.log("\nAll html templates valid.");
}

main();
