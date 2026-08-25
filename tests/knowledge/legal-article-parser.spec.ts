import assert from "node:assert/strict";
import test from "node:test";
import {
  cnToArabic,
  headingToArticleRecord,
  normalizeArticleId,
  parseArticleHeading,
  splitLawIntoArticles,
} from "../../src/knowledge/legal/article-parser.js";

// ---------------------------------------------------------------------------
// cnToArabic —— 中文数字转阿拉伯
// ---------------------------------------------------------------------------

test("cnToArabic: 单字数字与十/百/千组合", () => {
  assert.equal(cnToArabic("一"), 1);
  assert.equal(cnToArabic("十"), 10);
  assert.equal(cnToArabic("十一"), 11);
  assert.equal(cnToArabic("二十"), 20);
  assert.equal(cnToArabic("一百二十三"), 123);
  assert.equal(cnToArabic("二百五十"), 250);
  assert.equal(cnToArabic("一千"), 1000);
});

test("cnToArabic: 阿拉伯数字原样转换、零/〇归一", () => {
  assert.equal(cnToArabic("120"), 120);
  assert.equal(cnToArabic("零"), 0);
  assert.equal(cnToArabic("〇"), 0);
});

// ---------------------------------------------------------------------------
// parseArticleHeading —— 条款标题行解析
// ---------------------------------------------------------------------------

test("parseArticleHeading: 母条捕获条号与正文", () => {
  const parsed = parseArticleHeading("第一条 为了保护专利权人的合法权益，制定本法。");
  assert.ok(parsed);
  assert.equal(parsed.base, "第1条");
  assert.equal(parsed.baseZh, "第一条");
  assert.equal(parsed.sub, undefined);
  assert.equal(parsed.text, "为了保护专利权人的合法权益，制定本法。");
});

test("parseArticleHeading: 之M 子条（第一百二十条之一）", () => {
  const parsed = parseArticleHeading("第一百二十条之一 组织、领导恐怖活动组织的，处十年以上有期徒刑。");
  assert.ok(parsed);
  assert.equal(parsed.base, "第120条");
  assert.equal(parsed.baseZh, "第一百二十条");
  assert.equal(parsed.sub, "1");
  assert.equal(parsed.text, "组织、领导恐怖活动组织的，处十年以上有期徒刑。");
});

test("parseArticleHeading: 阿拉伯数字条号", () => {
  const parsed = parseArticleHeading("第22条 创造性，是指与现有技术相比，该发明具有突出的实质性特点和显著的进步。");
  assert.ok(parsed);
  assert.equal(parsed.base, "第22条");
  assert.equal(parsed.sub, undefined);
});

test("parseArticleHeading: 非条款标题返回 null", () => {
  assert.equal(parseArticleHeading("目录"), null);
  assert.equal(parseArticleHeading("第一章 总则"), null);
  assert.equal(parseArticleHeading("（一）一般规定"), null);
  assert.equal(parseArticleHeading(""), null);
});

// ---------------------------------------------------------------------------
// splitLawIntoArticles —— 合并块确定性切分
// ---------------------------------------------------------------------------

test("splitLawIntoArticles: 专利法合并块（第一条至第五条）切成 5 条", () => {
  // 对齐 knowledge.db chunks 真实形态：一个 chunk 含多条，行首"第N条"开新条。
  const merged = [
    "第一条 为了保护专利权人的合法权益，鼓励发明创造，推动发明创造的应用，提高创新能力，促进科学技术进步和经济社会发展，制定本法。",
    "第二条 本法所称的发明创造是指发明、实用新型和外观设计。",
    "发明，是指对产品、方法或者其改进所提出的新的技术方案。",
    "实用新型，是指对产品的形状、构造或者其结合所提出的适于实用的新的技术方案。",
    "外观设计，是指对产品的整体或者局部的形状、图案或者其结合以及色彩与形状、图案的结合所作出的富有美感并适于工业应用的新设计。",
    "第三条 国务院专利行政部门负责管理全国的专利工作；统一受理和审查专利申请，依法授予专利权。",
    "省、自治区、直辖市人民政府管理专利工作的部门负责本行政区域内的专利管理工作。",
    "第四条 申请专利的发明创造涉及国家安全或者重大利益需要保密的，按照国家有关规定办理。",
    "第五条 对违反法律、社会公德或者妨害公共利益的发明创造，不授予专利权。",
  ].join("\n");

  const fragments = splitLawIntoArticles(merged);
  assert.equal(fragments.length, 5);
  assert.equal(fragments[0]!.number, "第1条");
  assert.equal(
    fragments[0]!.content,
    "为了保护专利权人的合法权益，鼓励发明创造，推动发明创造的应用，提高创新能力，促进科学技术进步和经济社会发展，制定本法。",
  );
  assert.equal(fragments[4]!.number, "第5条");
  assert.equal(fragments[4]!.content, "对违反法律、社会公德或者妨害公共利益的发明创造，不授予专利权。");
});

test("splitLawIntoArticles: 长条二次切款——后续款行并入当前条", () => {
  const text = [
    "第二条 本法所称的发明创造是指发明、实用新型和外观设计。",
    "发明，是指对产品、方法或者其改进所提出的新的技术方案。",
    "实用新型，是指对产品的形状、构造或者其结合所提出的适于实用的新的技术方案。",
    "第三条 国务院专利行政部门负责管理全国的专利工作。",
  ].join("\n");

  const fragments = splitLawIntoArticles(text);
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0]!.number, "第2条");
  assert.ok(fragments[0]!.content.includes("发明，是指对产品、方法或者其改进所提出的新的技术方案。"));
  assert.ok(
    fragments[0]!.content.includes("实用新型，是指对产品的形状、构造或者其结合所提出的适于实用的新的技术方案。"),
  );
  assert.equal(fragments[1]!.number, "第3条");
});

test("splitLawIntoArticles: 正文内非行首的'第X条'引用不误切", () => {
  const text = [
    "第五条 对违反法律、社会公德或者妨害公共利益的发明创造，不授予专利权。",
    "依照本法第四条处理有关保密事项的发明创造，不授予专利权。",
  ].join("\n");

  const fragments = splitLawIntoArticles(text);
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0]!.number, "第5条");
  assert.ok(fragments[0]!.content.includes("依照本法第四条处理有关保密事项的发明创造"));
});

test("splitLawIntoArticles: 空输入返回空数组", () => {
  assert.deepEqual(splitLawIntoArticles(""), []);
});

// ---------------------------------------------------------------------------
// normalizeArticleId —— 两套 id 归一化 + 缺陷修复
// ---------------------------------------------------------------------------

test("normalizeArticleId: 中文/阿拉伯/含空格/去条后缀归一", () => {
  assert.equal(normalizeArticleId("第一条"), "第1条");
  assert.equal(normalizeArticleId("1条"), "第1条");
  assert.equal(normalizeArticleId("第1条"), "第1条");
  assert.equal(normalizeArticleId("第 2 条"), "第2条");
  assert.equal(normalizeArticleId("六条"), "第6条");
  // 归一化 id 全阿拉伯（程序对齐用）；原文"之M"形态保留在 article 展示字段。
  assert.equal(normalizeArticleId("第一百二十条之一"), "第120条之1");
});

test("normalizeArticleId: 修复'第第一条'缺陷", () => {
  assert.equal(normalizeArticleId("第第一条"), "第1条");
});

test("normalizeArticleId: 无法识别为条号时原样返回", () => {
  assert.equal(normalizeArticleId("总则"), "总则");
  assert.equal(normalizeArticleId(""), "");
});

// ---------------------------------------------------------------------------
// headingToArticleRecord —— LawRecord 条款字段
// ---------------------------------------------------------------------------

test("headingToArticleRecord: 母条映射 article（原文形态）/articleBase（归一化）", () => {
  assert.deepEqual(headingToArticleRecord("第一条 为了保护专利权人…"), {
    article: "第一条",
    articleBase: "第1条",
  });
});

test("headingToArticleRecord: 之M 子条映射 subArticle", () => {
  assert.deepEqual(headingToArticleRecord("第一百二十条之一 组织、领导…"), {
    article: "第一百二十条之一",
    articleBase: "第120条",
    subArticle: "1",
  });
});

test("headingToArticleRecord: 无标题/不可解析返回空对象", () => {
  assert.deepEqual(headingToArticleRecord(null), {});
  assert.deepEqual(headingToArticleRecord("目录"), {});
  assert.deepEqual(headingToArticleRecord(undefined), {});
});
