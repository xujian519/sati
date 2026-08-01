import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

/**
 * Validates the patent skills migrated from Mady (batch 1):
 * skills/patent-agent, patent-novelty-analysis, patent-infringement-check,
 * patent-oa-response — plus their references/ checklists.
 *
 * Mirrors the rules in src/extension/skills/SkillManager.ts:
 * slug pattern /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/, required `name` +
 * `description` frontmatter (>= 20 chars recommended), < 500-line guidance.
 */
const SKILLS_ROOT = resolve(import.meta.dirname, "../../../skills");

const PATENT_SKILLS = [
  "patent-agent",
  "patent-novelty-analysis",
  "patent-infringement-check",
  "patent-oa-response",
  "patent-draft-claims",
  "patent-draft-specification",
  "patent-write-abstract",
  "patent-disclosure-exam",
  "patent-clarity-exam",
  "patent-formal-exam",
  "patent-invalidity",
  "patent-unified-eval",
  "patent-prior-art-search",
  "patent-understand-disclosure",
] as const;

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

for (const slug of PATENT_SKILLS) {
  test(`patent skill ${slug} has valid SKILL.md`, async () => {
    assert.match(slug, SLUG_RE, `slug ${slug} must match SkillManager slug rules`);
    assert.ok(!slug.includes(".."), "slug must not contain ..");
    const content = await readFile(join(SKILLS_ROOT, slug, "SKILL.md"), "utf8");
    assert.ok(content.startsWith("---"), "SKILL.md must start with a YAML frontmatter block");
    const fm = parseFrontmatter(content);
    assert.equal(typeof fm.name, "string", "frontmatter requires name");
    assert.ok((fm.name as string).trim().length > 0, "frontmatter name must be non-empty");
    assert.equal(typeof fm.description, "string", "frontmatter requires description");
    const desc = (fm.description as string).trim();
    assert.ok(desc.length >= 20, `description should be >= 20 chars for discovery (got ${desc.length})`);
    assert.ok(desc.length <= 1024, "description must be <= 1024 chars");
    assert.ok(content.split("\n").length < 500, "SKILL.md should stay under 500 lines");
  });
}

test("patent-agent SKILL.md references its checklists and docs and they exist", async () => {
  const skillDir = join(SKILL_ROOT("patent-agent"));
  const content = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const references: string[] = [];
  const refRe = /references\/([a-z0-9-]+\.md)/g;
  for (const m of content.matchAll(refRe)) {
    references.push(m[1]);
  }
  assert.ok(references.length >= 3, `expected >= 3 referenced checklists, got ${references.length}`);
  // 质量自查清单必须含"检查清单"字样；协议/推理/标准/术语/去冗余为参考文档，仅断言存在。
  const checklists = ["claim-checklist.md", "spec-checklist.md", "oa-response-checklist.md", "quality-checklist.md"];
  for (const ref of references) {
    const refContent = await readFile(join(skillDir, "references", ref), "utf8");
    if (checklists.includes(ref)) {
      assert.ok(refContent.includes("检查清单"), `${ref} should be a checklist`);
    } else {
      assert.ok(refContent.trim().length > 0, `${ref} should exist and be non-empty`);
    }
  }
});

test("patent skills cross-reference each other without dangling paths", async () => {
  const agent = await readFile(join(SKILL_ROOT("patent-agent"), "SKILL.md"), "utf8");
  for (const other of ["patent-novelty-analysis", "patent-infringement-check", "patent-oa-response"]) {
    assert.ok(agent.includes(other), `patent-agent should reference ${other}`);
    const otherContent = await readFile(join(SKILL_ROOT(other), "SKILL.md"), "utf8");
    assert.ok(otherContent.includes("专利"), `${other} should be patent-domain content`);
  }
});

function SKILL_ROOT(slug: string): string {
  return join(SKILLS_ROOT, slug);
}
