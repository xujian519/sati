import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/**
 * 仓库根（向上找含 package.json 的目录）。
 * 兼容源运行（tests/skills/…，深度 2）与编译后运行（dist/tests/skills/…，深度 3），
 * 避免相对路径在两种布局下偏移（此前 "../../../skills" 在源布局指向仓库外）。
 */
function findRepoRoot(dir: string): string {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("无法定位仓库根（向上未找到 package.json）");
    current = parent;
  }
}

const SKILLS_ROOT = join(findRepoRoot(import.meta.dirname), "skills");

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

/**
 * provision-* 条款角色（skills 目录下 provision-<slug>/SKILL.md，type: role）。
 * 与 cap01-orchestrator.md §3.2 条款 worker 目录对应；check-patent-sop-references.mjs
 * 校验手册引用存在性（已注册角色不再走白名单）。
 */
const PROVISION_SLUGS = [
  "provision-disclosure", // P-A05 充分公开
  "provision-drafting-claims", // P-D01 权利要求撰写
  "provision-drafting-spec", // P-D02 说明书撰写
  "provision-novelty", // P-A01 新颖性
  "provision-inventiveness", // P-A02 创造性
  "provision-utility", // P-A03 实用性
  "provision-eligibility", // P-A04 保护客体
  "provision-claims-clarity", // P-A06 清楚/支持
  "provision-amendment", // P-A07 修改超范围
  "provision-prior-art", // P-C04 现有技术认定
  "provision-infringement-literal", // P-B02 全面覆盖
  "provision-infringement-equivalent", // P-B03 等同侵权
  "provision-unity", // P-A08 单一性
  "provision-design-auth", // P-A09 外观设计授权
  "provision-claim-construction", // P-B01 权利要求解释
  "provision-indirect-infringement", // P-B04 间接侵权
  "provision-defenses", // P-B05 抗辩
  "provision-damages", // P-B06 损害赔偿
  "provision-ownership", // P-C01 权属
  "provision-invalidity-procedure", // P-C02 无效程序
  "provision-reexamination", // P-C03 复审
  "provision-priority", // P-C05 优先权
] as const;

const ALL_ROLE_SLUGS = [...ROLE_SLUGS, ...PROVISION_SLUGS];

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
  "literature",
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

for (const slug of ALL_ROLE_SLUGS) {
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
