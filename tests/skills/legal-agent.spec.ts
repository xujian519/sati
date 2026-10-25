import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * legal-agent 的文案契约测试（#740 / S-10）。
 *
 * 只证明 SKILL.md 声明了「强制核验」与「法条 → 案例」检索分层，**不证明运行时强制**：
 * 模型是否真的调用 law_verify 属于运行时行为，需另行用会话/重放验证。
 * 同一口径见 tests/skills/patent-roles.spec.ts 的契约测试说明。
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");
const SKILL_PATH = join(SKILLS_ROOT, "legal-agent", "SKILL.md");
// 读源文件而非 dist：注释在编译后会被保留，但测试要覆盖的是仓库里那份文案。
const EVIDENCE_INDEX = join(REPO_ROOT, "src/patent/evidence/index.ts");

async function readSkill(): Promise<string> {
  return readFile(SKILL_PATH, "utf8");
}

/** 取某个二级标题到下一个二级标题之间的正文（标题不存在时抛错，避免静默空串）。 */
function section(content: string, heading: string): string {
  const start = content.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `缺少「## ${heading}」段`);
  const rest = content.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test("legal-agent: law_verify 是强制动作，核心原则与质量门禁都要求逐条核验", async () => {
  const content = await readSkill();

  const principles = section(content, "核心原则");
  assert.match(principles, /`law_verify`/, "核心原则须点名 law_verify");
  assert.match(principles, /强制动作/, "核心原则须把 law_verify 标为强制动作");
  assert.match(principles, /未核验的引用不得作为结论依据/);

  const gates = section(content, "质量门禁");
  assert.match(gates, /`law_verify`/, "质量门禁须把 law_verify 列为检查项");
  assert.match(gates, /每一条法条都经过/, "质量门禁须要求逐条核验");

  const mandatory = section(content, "法条核验（强制）");
  assert.match(mandatory, /逐份调用|对分析全文调用/, "须说明核验调用面");
});

test("legal-agent: 五态判定逐一给出处置（无静默放行）", async () => {
  const mandatory = section(await readSkill(), "法条核验（强制）");

  for (const decision of ["valid", "mismatch", "out-of-range", "not-indexed", "unverified"]) {
    assert.ok(mandatory.includes(`\`${decision}\``), `缺少判定「${decision}」`);
  }
  assert.match(mandatory, /`mismatch`[^\n]*\|[^\n]*拦截/, "mismatch 须有拦截处置");
  assert.match(mandatory, /`out-of-range`[^\n]*\|[^\n]*拦截/, "out-of-range 须有拦截处置");
  assert.match(mandatory, /`not-indexed`[^\n]*\|[^\n]*标注/, "not-indexed 须显式标注");
  assert.match(mandatory, /`unverified`[^\n]*\|[^\n]*不得当作已核验/, "unverified 不得当已核验");
});

test("legal-agent: 检索顺序为法条 → 核验 → 案例", async () => {
  const layering = section(await readSkill(), "检索分层（法条 → 案例）");

  const lawSearch = layering.indexOf("`law_search`");
  const lawVerify = layering.indexOf("`law_verify`");
  const caseSearch = layering.indexOf("`patent_case_search`");
  assert.ok(lawSearch >= 0, "检索分层须以 law_search 起手");
  assert.ok(lawVerify > lawSearch, "law_verify 须排在 law_search 之后");
  assert.ok(caseSearch > lawVerify, "案例检索须排在核验之后");

  assert.match(layering, /顺序不得颠倒/);
  assert.match(layering, /案例不能替代法条/);
});

test("legal-agent: law_verify 只作形式门禁，并声明不可用时的降级标注", async () => {
  const content = await readSkill();

  assert.match(content, /引用形式门禁/);
  assert.match(content, /不判命题正确性/);
  assert.doesNotMatch(content, /保证命题正确|命题正确性得到保证/);

  assert.match(content, /未做形式核验/, "不可用时须显式标注未核验");
  assert.match(content, /不得静默/, "降级不得静默当通过");
  assert.match(content, /漏掉编造条号与越界条号/, "降级须说明谁因此漏了什么");
});

test("evidence/index.ts 头注释不再声称领域判定「留二期」", async () => {
  const source = await readFile(EVIDENCE_INDEX, "utf8");
  const headerEnd = source.indexOf("*/");
  assert.ok(headerEnd > 0, "evidence/index.ts 应有文件头注释");
  const header = source.slice(0, headerEnd);

  assert.doesNotMatch(header, /留二期/, "头注释须反映 engine.ts 已实现领域判定");
  assert.match(header, /engine\.ts/, "头注释须指向实现所在");
  assert.match(header, /三性|举证责任|证明标准/);
  assert.match(header, /law_verify/, "头注释须写明法律面核验的归属");
});
