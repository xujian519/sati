/**
 * src/knowledge/legal — 法条引用核验（law_verify）判据。
 *
 * 分三层：
 * ① 纯函数（法名归一化 / 条号连续性 / 引用抽取 / 命题匹配）——不碰库；
 * ② 判定（用假索引覆盖五种 decision，含「降级不得判 valid」的安全网）；
 * ③ 真实知识库的集成断言（无库时**显式 skip**，不是"跑过了没问题"）。
 *
 * 第 ③ 层用 `{ skip }` 而非 `return`：本仓库里有过「无依赖时 return，于是 CI 上这条永远
 * 记为通过」的先例，那会把「没跑」伪装成「通过」。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildLawIndex,
  isLawLikeName,
  loadLawIndex,
  maxContiguousArticle,
  normalizeLawName,
  type LawEntry,
  type LawIndex,
} from "../../../src/knowledge/legal/law-index.js";
import {
  DECISION_SEVERITY,
  evaluateProposition,
  extractLawReferences,
  verifyCitation,
  verifyCitations,
  type LawArticleReference,
} from "../../../src/knowledge/legal/law-verify.js";
import {
  createLawVerifyTool,
  renderLawVerifyReport,
  toLawVerifyOutput,
} from "../../../src/knowledge/legal/law-verify-tool.js";
import { makeToolContext } from "../../tool/context-fixture.js";

/** 造一个假索引（只填判定用得上的字段）。 */
function fakeIndex(
  entries: Array<{ law: string; maxArticle: number; articles?: Record<number, string>; source?: string }>,
): LawIndex {
  const map = new Map<string, LawEntry>();
  for (const input of entries) {
    const articles = new Map(
      Object.entries(input.articles ?? {}).map(([number, text]) => [Number(number), { number: Number(number), text }]),
    );
    map.set(input.law, {
      law: input.law,
      documentId: `doc:${input.law}`,
      documentTitle: input.law,
      source: input.source ?? "raw",
      maxArticle: input.maxArticle,
      articles,
      candidates: [],
    });
  }
  return { entries: map, lawNames: [...map.keys()].sort((a, b) => b.length - a.length) };
}

/** 一条法条引用。 */
function ref(law: string, article: number, raw = `《${law}》第${article}条`): LawArticleReference {
  return { kind: "law-article", law, article, raw };
}

// ---------------------------------------------------------------- 纯函数

test("法名归一化：去书名号/去国名前缀/去括号与破折号后缀/去章节序号前缀", () => {
  assert.equal(normalizeLawName("中华人民共和国专利法"), "专利法");
  assert.equal(normalizeLawName("中华人民共和国专利法（2020年修正）"), "专利法");
  assert.equal(normalizeLawName("中华人民共和国专利法（2020年修正）（分拆 01）"), "专利法");
  assert.equal(normalizeLawName("专利法实施细则（2023年修订）— 审查批准与复审无效（第37-69条）"), "专利法实施细则");
  // 剥序号前缀不是美化：库里「一、山东省专利条例」（wiki，0 条）与「山东省专利条例」（raw，33 条）
  // 是同一部法；不剥前缀会让抽引用优先命中前者，把合法条号判成 not-indexed。
  assert.equal(normalizeLawName("一、山东省专利条例（2025年修订）"), "山东省专利条例");
  assert.equal(normalizeLawName("第五章 商标相同、近似的审查审理"), "商标相同、近似的审查审理");
});

test("法名形态判据：法规后缀白名单", () => {
  for (const name of [
    "专利法",
    "专利法实施细则",
    "山东省专利条例",
    "专利代理管理办法",
    "专利审查指南",
    "国防专利条例",
  ]) {
    assert.ok(isLawLikeName(name), `${name} 应被判为法规名`);
  }
  // 实测库里 doc_type='law_article' 混入的语料片段——它们进不了引用位置，却是法名污染的来源。
  for (const noise of ["CLAUDE.md", "分拆目录", "条文与解读", "与其他知识库的关联", "商标实例卡片库"]) {
    assert.ok(!isLawLikeName(noise), `${noise} 不应被判为法规名`);
  }
});

test("条号连续上界：1..N 全在场取最大 N，缺号即截断", () => {
  assert.equal(maxContiguousArticle(new Set([1, 2, 3])), 3);
  assert.equal(maxContiguousArticle(new Set([1, 2, 4])), 2, "缺第 3 条 ⇒ 上界只能到 2");
  assert.equal(maxContiguousArticle(new Set([2, 3])), 0, "没有第 1 条 ⇒ 上界应为 0（无法证明）");
  assert.equal(maxContiguousArticle(new Set()), 0);
});

test("引用抽取：书名号、无书名号、中文/阿拉伯数字、款与项", () => {
  assert.deepEqual(extractLawReferences("《专利法》第一百二十条", []), [ref("专利法", 120, "《专利法》第一百二十条")]);
  assert.deepEqual(extractLawReferences("《专利法实施细则》第150条", []), [
    ref("专利法实施细则", 150, "《专利法实施细则》第150条"),
  ]);

  const withParts = extractLawReferences("《专利法》第二十二条第三款第二项", []);
  assert.equal(withParts.length, 1);
  assert.deepEqual(
    {
      law: withParts[0]!.law,
      article: withParts[0]!.article,
      paragraph: withParts[0]!.paragraph,
      item: withParts[0]!.item,
    },
    { law: "专利法", article: 22, paragraph: 3, item: 2 },
  );

  // 无书名号依赖法名表（表中按长度降序，长名优先，避免「专利法」抢走「专利法实施细则」）。
  const noMark = extractLawReferences("依据专利法第二十二条第三款的规定", ["专利法实施细则", "专利法"]);
  assert.equal(noMark.length, 1);
  assert.equal(noMark[0]!.law, "专利法");
  assert.equal(noMark[0]!.article, 22);
});

test("引用抽取：同一处引用只出一条（书名号路径与法名路径重叠时）", () => {
  const found = extractLawReferences("《专利法》第二十二条", ["专利法"]);
  assert.equal(found.length, 1, JSON.stringify(found));
});

test("引用抽取：编造的法名也能被抽出（否则会被静默忽略而不是报 not-indexed）", () => {
  const found = extractLawReferences("《中华人民共和国专利促进法》第一条", ["专利法"]);
  assert.equal(found.length, 1, "未收录法名不得静默丢弃——那是比判错更糟的失效模式");
  assert.equal(found[0]!.law, "中华人民共和国专利促进法");
});

test("引用抽取：A22.3 简写形态不抽（无可靠边界，硬匹配会误伤 A4纸 这类词）", () => {
  assert.deepEqual(extractLawReferences("参见 A22.3 的规定", ["专利法"]), []);
});

test("命题匹配：重合强度如实给出，零重合才判 mismatch", () => {
  const article =
    "授予专利权的发明和实用新型，应当具备新颖性、创造性和实用性。创造性，是指与现有技术相比，该发明具有突出的实质性特点和显著的进步。";

  const exact = evaluateProposition(article, "创造性是指与现有技术相比该发明具有突出的实质性特点和显著的进步");
  assert.equal(exact.verdict, "match");
  assert.ok(exact.evidence.shared / exact.evidence.total >= 0.5, "逐字引用的重合应很高");

  // ⚠️ 这条是**实测记录**而非缺陷测试：同义改写仍会共享个别片段（「技术相」）。
  const paraphrase = evaluateProposition(article, "与在先技术相较，本发明呈现出非显而易见性");
  assert.equal(paraphrase.verdict, "match", "同义改写不判 mismatch——否则 block 级会误伤");
  assert.ok(paraphrase.evidence.shared / paraphrase.evidence.total < 0.5, "但它必须被报成弱重合");

  assert.equal(evaluateProposition(article, "今天天气晴朗适合出行散步").verdict, "mismatch");
  assert.equal(evaluateProposition(article, undefined).verdict, "match");
  // 命题不足 3 字 ⇒ 切不出任何三字片段 ⇒ 无法机械比对（不据此判 mismatch）。
  assert.equal(evaluateProposition(article, "新颖").verdict, "undecidable");
});

// ---------------------------------------------------------------- 判定（假索引）

test("判定：五态各就各位", () => {
  const index = fakeIndex([
    { law: "专利法", maxArticle: 82, articles: { 22: "创造性，是指与现有技术相比……" } },
    { law: "商标法", maxArticle: 0 },
    { law: "商标法实施条例", maxArticle: 0, source: "wiki" },
  ]);

  assert.equal(verifyCitation(ref("专利法", 22), index).decision, "valid");
  assert.equal(verifyCitation(ref("专利法", 120), index).decision, "out-of-range");
  assert.equal(verifyCitation(ref("专利法", 23), index).decision, "not-indexed", "上界内但未切出该条");
  assert.equal(verifyCitation(ref("不存在的法", 1), index).decision, "not-indexed");
  assert.equal(verifyCitation(ref("商标法", 1), index).decision, "not-indexed", "上界未证明时不得判 out-of-range");
  assert.match(
    verifyCitation(ref("商标法", 1), index).reason,
    /未能证明条号上界/,
    "「上界未证明」与「未收录」必须能分清",
  );
});

test("判定：非 raw 来源判 unverified 而非 valid", () => {
  const index = fakeIndex([{ law: "某条例", maxArticle: 10, articles: { 1: "第一条内容" }, source: "wiki" }]);
  const finding = verifyCitation(ref("某条例", 1), index);
  assert.equal(finding.decision, "unverified");
  assert.match(finding.reason, /wiki/);
});

test("判定：命题零重合判 mismatch，弱重合判 valid 但理由里带出强度", () => {
  const index = fakeIndex([
    {
      law: "专利法",
      maxArticle: 82,
      articles: { 22: "创造性，是指与现有技术相比，该发明具有突出的实质性特点和显著的进步。" },
    },
  ]);

  const mismatched = verifyCitation(ref("专利法", 22), index, "今天天气晴朗适合出行散步");
  assert.equal(mismatched.decision, "mismatch");
  assert.equal(DECISION_SEVERITY[mismatched.decision], "block");

  const weak = verifyCitation(ref("专利法", 22), index, "与在先技术相较，本发明呈现出非显而易见性");
  assert.equal(weak.decision, "valid");
  assert.match(weak.reason, /仅重合 \d+\/\d+ 个三字片段/, weak.reason);
});

test("判定：多处引用按出现顺序、逐条独立判定", () => {
  const index = fakeIndex([{ law: "专利法", maxArticle: 82, articles: { 22: "内容" } }]);
  const findings = verifyCitations("《专利法》第一百二十条与《专利法》第二十二条", index);
  assert.equal(findings.length, 2);
  assert.equal(findings[0]!.decision, "out-of-range");
  assert.equal(findings[1]!.decision, "valid");
});

// ---------------------------------------------------------------- 工具层

test("工具：索引不可用时必须报错，绝不返回 valid（最危险的失效模式是静默放行）", async () => {
  const tool = createLawVerifyTool(() => undefined);
  const result = await tool.execute({ text: "《专利法》第一百二十条" }, makeToolContext());
  const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
  assert.match(text, /错误：/);
  assert.match(text, /未经核验/);
  assert.match(text, /不要把这当成/, "必须明确警告「没核成就不能当通过」");
  assert.equal(result.data, undefined, "未核验时不得给出结构化结论");
  assert.equal((result.metadata as { error?: string } | undefined)?.error, "knowledge_db_unavailable");
});

test("工具：报告把拦截项标出，并提示「条号成立 ≠ 命题被支撑」", () => {
  const output = toLawVerifyOutput(
    [
      { ...verifyCitation(ref("专利法", 120), fakeIndex([{ law: "专利法", maxArticle: 82 }])) },
      {
        ...verifyCitation(ref("专利法", 22), fakeIndex([{ law: "专利法", maxArticle: 82, articles: { 22: "内容" } }])),
      },
    ],
    "/tmp/knowledge.db",
    1,
  );
  assert.equal(output.total, 2);
  assert.equal(output.blocked, 1);
  const report = renderLawVerifyReport(output);
  assert.match(report, /⛔/);
  assert.match(report, /需拦截/);
});

test("工具：无引用时给明确结论而不是空白", () => {
  const report = renderLawVerifyReport(toLawVerifyOutput([], "/tmp/k.db", 1));
  assert.match(report, /未在文本中发现法条引用/);
});

// ---------------------------------------------------------------- 真实知识库

const loaded = loadLawIndex();

test("真实知识库：专利法 82 条 / 实施细则 149 条，且权威源是管道全文", {
  skip: loaded === undefined ? "本机无 knowledge.db，跳过（不计入通过）" : false,
}, () => {
  assert.ok(loaded);
  const patentLaw = loaded.index.entries.get("专利法");
  const rules = loaded.index.entries.get("专利法实施细则");
  assert.ok(patentLaw, "应选到《专利法》");
  assert.ok(rules, "应选到《专利法实施细则》");
  assert.equal(patentLaw.maxArticle, 82);
  assert.equal(rules.maxArticle, 149);
  assert.equal(patentLaw.source, "raw", "权威源应是管道全文，不是 wiki 摘要");
  // 选源不许静默：落选者必须留在报告里。
  assert.ok(patentLaw.candidates.length > 1, "同法名的 wiki 碎片应作为落选候选留档");
  assert.ok(patentLaw.candidates.every(candidate => candidate.maxContig <= 82));
});

test("真实知识库：计划里的反例逐条复跑", {
  skip: loaded === undefined ? "本机无 knowledge.db，跳过（不计入通过）" : false,
}, () => {
  assert.ok(loaded);
  const decide = (text: string): string => verifyCitations(text, loaded.index)[0]?.decision ?? "(无引用)";
  assert.equal(decide("《专利法》第一百二十条"), "out-of-range");
  assert.equal(decide("《专利法》第八十三条"), "out-of-range");
  assert.equal(decide("《专利法实施细则》第一百五十条"), "out-of-range");
  assert.equal(decide("《中华人民共和国专利促进法》第一条"), "not-indexed", "编造法名");
  assert.equal(decide("专利法第二十二条第三款"), "valid", "不写书名号的常见形态");
  // 选源修复的回归：同一部法在库里有「一、山东省专利条例」（wiki）与「山东省专利条例」（raw）。
  assert.equal(decide("《山东省专利条例》第五条"), "valid");
});

test("真实知识库：索引构建自身不抛错且能覆盖多部法规", {
  skip: loaded === undefined ? "本机无 knowledge.db，跳过（不计入通过）" : false,
}, () => {
  assert.ok(loaded);
  assert.ok(loaded.index.entries.size >= 5, `应索引到多部法规，实测 ${loaded.index.entries.size}`);
  assert.ok(loaded.index.lawNames.length > 0, "应至少有一个可被引用识别的法名");
});

test("buildLawIndex 在空库上返回空索引而不是抛错", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE documents (id TEXT, source TEXT, doc_type TEXT, title TEXT, char_count INTEGER);" +
      "CREATE TABLE chunks (id INTEGER, document_id TEXT, chunk_index INTEGER, heading TEXT, content TEXT, char_count INTEGER);",
  );
  const index = buildLawIndex(db);
  assert.equal(index.entries.size, 0);
  db.close();
});
