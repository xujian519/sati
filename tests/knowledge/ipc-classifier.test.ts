import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyIpc,
  classifyIpcTop,
  getIpcDomain,
  IPC_DETAIL_MIN_CONFIDENCE,
  isHighConfidence,
} from "../../src/knowledge/patent/ipc-classifier.js";

describe("ipc-classifier", () => {
  it("对图像识别/计算类文本分类到 G（物理），两级 detail 到 G06（计算）", () => {
    const results = classifyIpc("一种基于深度学习的图像识别方法，通过数据处理算法对图像进行处理");
    const top = results[0];
    assert.equal(top.section, "G");
    assert.ok(top.confidence >= 0.5);
    assert.ok(top.matchedKeywords.includes("数据处理") || top.matchedKeywords.includes("图像处理"));
    assert.equal(top.detail, "G06");
    assert.ok(top.detailConfidence !== undefined && top.detailConfidence >= IPC_DETAIL_MIN_CONFIDENCE);
  });

  it("对化学合成类文本分类到 C（化学/冶金），两级 detail 到 C07（有机化学）", () => {
    const top = classifyIpcTop("一种高分子化合物的合成方法，涉及催化剂和化学反应");
    assert.equal(top.section, "C");
    assert.ok(top.confidence >= 0.5);
    assert.equal(top.detail, "C07");
  });

  it("对通信电子类文本分类到 H（电学），两级 detail 到 H04（电子通信）", () => {
    const top = classifyIpcTop("一种无线通信电路，包含集成电路芯片和天线，用于移动通信网络");
    assert.equal(top.section, "H");
    assert.ok(top.confidence >= 0.5);
    assert.equal(top.detail, "H04");
  });

  it("对车辆类文本两级 detail 到 B60（车辆）", () => {
    const top = classifyIpcTop("一种汽车车架的制造方法，涉及焊接和冲压工艺");
    assert.equal(top.section, "B");
    assert.equal(top.detail, "B60");
  });

  it("部级命中但大类关键词未命中时不产出 detail", () => {
    const top = classifyIpcTop("一种折叠桌椅组合结构，用于室内家具");
    assert.equal(top.section, "A");
    assert.equal(top.detail, undefined);
  });

  it("归一化后同等命中数跨部置信度一致（消除关键词表长度偏差）", () => {
    const a = classifyIpcTop("医药药物药品").confidence;
    const d = classifyIpcTop("纺织织物纤维").confidence;
    // A 部 35 词命中 3 词与 D 部 19 词命中 3 词应得到相同置信度
    assert.equal(a, d);
    assert.ok(a > 0.7);
  });

  it("大类命中 1 词时 detailConfidence 低于精注入门槛，≥2 词时达标", () => {
    const single = classifyIpcTop("一种手性组合物");
    assert.equal(single.detail, "C07");
    assert.ok(single.detailConfidence !== undefined && single.detailConfidence < IPC_DETAIL_MIN_CONFIDENCE);
    const multi = classifyIpcTop("一种手性有机化合物中间体");
    assert.equal(multi.detail, "C07");
    assert.ok(multi.detailConfidence !== undefined && multi.detailConfidence >= IPC_DETAIL_MIN_CONFIDENCE);
  });

  it("无匹配时返回默认 B 部和低置信度", () => {
    const results = classifyIpc("今天天气很好");
    assert.equal(results[0].section, "B");
    assert.equal(results[0].confidence, 0.15);
  });

  it("多部命中时按置信度降序排列", () => {
    const results = classifyIpc("一种汽车发动机的制造方法，涉及金属合金材料");
    const sections = results.map(r => r.section);
    for (let i = 1; i < sections.length; i++) {
      assert.ok(results[i - 1].confidence >= results[i].confidence);
    }
  });

  it("isHighConfidence 阈值判定", () => {
    assert.equal(isHighConfidence(0.8), true);
    assert.equal(isHighConfidence(0.79), false);
  });

  it("getIpcDomain 返回元数据", () => {
    const domain = getIpcDomain("G");
    assert.ok(domain);
    assert.equal(domain.name, "物理");
    assert.ok(domain.inventivenessFocus.length > 0);
    assert.equal(getIpcDomain("Z"), undefined);
  });
});
