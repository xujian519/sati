import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { parseRoleConfig } from "../../src/extension/skills/roleConfig.js";
import { roleFromSkill } from "../../src/agent/sub/roleFromSkill.js";
import type { SkillSummary } from "../../src/extension/skills/types.js";

/**
 * Validates the patent role skills (type: role) migrated from YunXi:
 * skills/patent-{retriever,analyzer,writer,novelty-checker,creativity-checker,
 * infringement-checker,invalidity-checker,reviewer,quality-checker}.
 *
 * Mirrors src/agent/sub/roleFromSkill.ts + src/extension/skills/roleConfig.ts:
 * frontmatter `type: "role"` with tools/domains/omitTools/readOnly/systemPrompt;
 * role id = skill slug.
 */
const SKILLS_ROOT = resolve(import.meta.dirname, "../../../skills");

const ROLE_SLUGS = [
  "patent-retriever",
  "patent-analyzer",
  "patent-writer",
  "patent-novelty-checker",
  "patent-creativity-checker",
  "patent-infringement-checker",
  "patent-invalidity-checker",
  "patent-reviewer",
  "patent-quality-checker",
] as const;

// 与 src/tool/protocol/types.ts 的 ToolDomain 值域保持一致
const TOOL_DOMAINS = new Set([
  "filesystem",
  "shell",
  "network",
  "search",
  "document",
  "analysis",
  "drafting",
  "quality",
  "patent",
  "legal",
  "agent",
  "session",
  "mcp",
  "custom",
]);

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

for (const slug of ROLE_SLUGS) {
  test(`role skill ${slug} has valid type: role frontmatter`, async () => {
    const content = await readFile(join(SKILLS_ROOT, slug, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(content);
    assert.equal(fm.type, "role", "frontmatter must declare type: role");
    assert.equal(typeof fm.name, "string", "frontmatter requires name");
    assert.ok((fm.name as string).trim().length > 0, "name must be non-empty");
    assert.equal(typeof fm.description, "string", "frontmatter requires description");
    assert.ok((fm.description as string).trim().length >= 20, "description should be >= 20 chars");
    assert.ok(Array.isArray(fm.tools) && (fm.tools as string[]).includes("*"), "tools should allow *");
    const domains = fm.domains as string[];
    assert.ok(Array.isArray(domains) && domains.length > 0, "domains should be a non-empty array");
    for (const d of domains) {
      assert.ok(TOOL_DOMAINS.has(d), `domain "${d}" must be a known ToolDomain`);
    }
    if (fm.omitTools !== undefined) {
      assert.ok(Array.isArray(fm.omitTools), "omitTools should be an array");
    }
    if (fm.readOnly !== undefined) {
      assert.equal(typeof fm.readOnly, "boolean", "readOnly should be boolean");
    }
    assert.equal(typeof fm.systemPrompt, "string", "systemPrompt is required");
    assert.ok((fm.systemPrompt as string).trim().length > 0, "systemPrompt must be non-empty");
    assert.ok(content.split("\n").length < 500, "SKILL.md should stay under 500 lines");
  });

  test(`role skill ${slug} registers a SubagentDefinition via roleFromSkill`, async () => {
    const content = await readFile(join(SKILLS_ROOT, slug, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(content);
    const role = parseRoleConfig(fm);
    const summary = {
      slug,
      description: (fm.description as string) ?? slug,
      role,
    } as SkillSummary;
    const definition = roleFromSkill(summary);
    assert.notEqual(definition, null, "roleFromSkill must return a definition");
    assert.equal(definition!.id, slug, "role id must equal skill slug (subagent_type)");
    assert.deepEqual(definition!.visibleDomains, role.domains, "domains must map to visibleDomains");
    assert.equal(definition!.isReadOnly, role.readOnly ?? false, "readOnly mapping");
    assert.deepEqual(definition!.omitTools, role.omitTools ?? undefined, "omitTools mapping");
    assert.equal(definition!.systemPromptSuffix, role.systemPrompt ?? "", "systemPrompt mapping");
  });
}
