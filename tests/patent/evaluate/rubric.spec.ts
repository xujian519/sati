import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateRubricScore, parseRubric } from "../../../src/patent/evaluate/rubric.js";

describe("parseRubric", () => {
  it("合法 YAML 解析出 items 与权重", () => {
    const text = `
max_score: 100
items:
  - id: three_step_method
    weight: 0.5
    criterion: 是否显式使用三步法。
    behavior: observable
  - id: legal_citation_correct
    weight: 0.5
    criterion: 引用的法条是否正确。
    behavior: observable
`;
    const result = parseRubric(text);
    assert.equal(result.error, null);
    assert.equal(result.rubric!.maxScore, 100);
    assert.equal(result.rubric!.items.length, 2);
    assert.equal(result.rubric!.items[0]!.id, "three_step_method");
    assert.equal(result.rubric!.items[0]!.weight, 0.5);
  });

  it("非法 YAML 容错归一为 error", () => {
    const result = parseRubric("items: [ { bad");
    assert.notEqual(result.error, null);
    assert.equal(result.rubric, null);
  });

  it("缺 items 报错", () => {
    const result = parseRubric("max_score: 100\n");
    assert.notEqual(result.error, null);
  });

  it("weight 之和非 1 报错", () => {
    const result = parseRubric(`
items:
  - id: a
    weight: 0.4
    criterion: x。
    behavior: observable
  - id: b
    weight: 0.3
    criterion: y。
    behavior: observable
`);
    assert.notEqual(result.error, null);
    assert.match(result.error!, /weight/);
  });

  it("behavior 不是 observable 报错（拒绝不可观察评分项）", () => {
    const result = parseRubric(`
items:
  - id: a
    weight: 1
    criterion: 分析是否全面充分。
    behavior: thoroughness
`);
    assert.notEqual(result.error, null);
    assert.match(result.error!, /observable/);
  });
});

describe("aggregateRubricScore", () => {
  const rubric = parseRubric(`
max_score: 100
items:
  - id: a
    weight: 0.6
    criterion: x。
    behavior: observable
  - id: b
    weight: 0.4
    criterion: y。
    behavior: observable
`).rubric!;

  it("全部通过 = 满分", () => {
    assert.equal(aggregateRubricScore({ a: true, b: true }, rubric), 100);
  });

  it("按权重折算", () => {
    assert.equal(aggregateRubricScore({ a: true, b: false }, rubric), 60);
    assert.equal(aggregateRubricScore({ a: false, b: true }, rubric), 40);
  });

  it("全部未通过 = 0", () => {
    assert.equal(aggregateRubricScore({ a: false, b: false }, rubric), 0);
  });
});
