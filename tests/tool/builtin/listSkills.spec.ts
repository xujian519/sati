/**
 * `list_skills`：分组按需展开（组 → 名字 + 描述），归组规则与 prompt 渲染同源。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createListSkillsTool } from "../../../src/tool/builtin/listSkills.js";

/** 工具不读运行时上下文（只读清单），用空桩满足签名。 */
const CONTEXT = {} as SatiToolRuntimeContext;

const SKILLS = [
  { name: "legal-litigation-demand-draft", description: "Draft a demand letter.", path: "/opt/skills/x/SKILL.md" },
  { name: "legal-litigation-chronology", description: "Build a chronology.", path: "/opt/skills/y/SKILL.md" },
  { name: "legal-employment-policy-check", description: "Check a policy.", path: "/opt/skills/z/SKILL.md" },
  { name: "patent-search", description: "Search prior art.", path: "/opt/skills/p/SKILL.md" },
];

function tool() {
  return createListSkillsTool({ lister: () => SKILLS });
}

test("无 group 时只列分组概览（id / 计数 / 组摘要），不含逐条描述", async () => {
  const result = await tool().execute({}, CONTEXT);
  assert.equal(result.data?.total, 4);
  assert.deepEqual(
    result.data?.groups.map(group => group.id),
    ["patent", "legal/litigation", "legal/employment"],
  );
  assert.equal(result.data?.groups[0]?.count, 1);
  assert.equal(result.data?.groups[1]?.count, 2);
  for (const group of result.data?.groups ?? []) {
    assert.equal(group.skills, undefined);
  }
  const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
  assert.match(text, /- legal\/litigation \(Legal · Litigation, 2 skills\)/);
  assert.doesNotMatch(text, /Draft a demand letter/);
});

test("指定 group 时展开该组的名字与描述", async () => {
  const result = await tool().execute({ group: "legal/litigation" }, CONTEXT);
  assert.equal(result.data?.groups.length, 1);
  assert.deepEqual(result.data?.groups[0]?.skills, [
    { name: "legal-litigation-demand-draft", description: "Draft a demand letter." },
    { name: "legal-litigation-chronology", description: "Build a chronology." },
  ]);
  const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
  assert.match(text, /legal-litigation-demand-draft — Draft a demand letter\./);
});

test("父组 id 展开全部子组（legal → legal/*）", async () => {
  const result = await tool().execute({ group: "legal" }, CONTEXT);
  assert.deepEqual(
    result.data?.groups.map(group => group.id),
    ["legal/litigation", "legal/employment"],
  );
  assert.ok(result.data?.groups.every(group => group.skills?.length));
});

test("未知分组返回可区分的空结果并列出可用分组", async () => {
  const result = await tool().execute({ group: "nope" }, CONTEXT);
  assert.deepEqual(result.data, { total: 4, groups: [] });
  const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
  assert.match(text, /No skill group 'nope' found/);
  assert.match(text, /patent, legal\/litigation, legal\/employment/);
});

test("无技能时返回空概览且不报错", async () => {
  const result = await createListSkillsTool({ lister: () => [] }).execute({}, CONTEXT);
  assert.deepEqual(result.data, { total: 0, groups: [] });
});
