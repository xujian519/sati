import assert from "node:assert/strict";
import test from "node:test";
import { conclusionDirection, extractDirection } from "../../src/patent/evaluate/metrics.js";

test("extractDirection: 只认单行固定标记（结论：具备/不具备创造性）", () => {
  assert.equal(extractDirection("结论：具备创造性"), "inventive");
  assert.equal(extractDirection("分析…\n结论：不具备创造性"), "not_inventive");
  assert.equal(extractDirection("结论： 具备创造性（置信度 high）"), "inventive");
  assert.equal(extractDirection("结论:具备创造性"), "inventive", "半角冒号兼容");
  // 正文其他含"创造"的表述不参与方向判定。
  assert.equal(extractDirection("该权利要求具备创造性，区别特征带来技术效果"), undefined);
  assert.equal(extractDirection("本案不具备创造性。结论如上"), undefined);
  // 矛盾输出（正反同时出现）→ 无法判定。
  assert.equal(extractDirection("结论：具备创造性\n结论：不具备创造性"), undefined);
});

test("conclusionDirection: 方向一致 → 1，方向相反 → 0", () => {
  assert.equal(conclusionDirection("结论：具备创造性", "…报告\n结论：具备创造性"), 1);
  assert.equal(conclusionDirection("结论：具备创造性", "…报告\n结论：不具备创造性"), 0);
  assert.equal(conclusionDirection("结论：不具备创造性", "…报告\n结论：不具备创造性"), 1);
  assert.equal(conclusionDirection("结论：不具备创造性", "…报告\n结论：具备创造性"), 0);
});

test("conclusionDirection: actual 自然表述（无'结论：'前缀）用否定窗口语义判定（P1-3）", () => {
  // "本申请相对D1具备创造性" → 肯定方向。
  assert.equal(conclusionDirection("结论：具备创造性", "综上，本申请相对D1具备创造性，置信度为high"), 1);
  assert.equal(conclusionDirection("结论：不具备创造性", "综上，本申请相对D1具备创造性，置信度为high"), 0);
  // "权利要求1不具备创造性" → 否定方向。
  assert.equal(conclusionDirection("结论：不具备创造性", "权利要求1不具备创造性"), 1);
  assert.equal(conclusionDirection("结论：具备创造性", "权利要求1不具备创造性"), 0);
  // "并不具备创造性" 同样命中否定。
  assert.equal(conclusionDirection("结论：不具备创造性", "该方案并不具备创造性"), 1);
  // "无法通过三步法确立创造性" / "不能认定具备创造性" → 否定方向。
  assert.equal(conclusionDirection("结论：不具备创造性", "不存在区别技术特征，无法通过三步法确立创造性"), 1);
  assert.equal(conclusionDirection("结论：不具备创造性", "不能认定具备创造性"), 1);
  // "具有创造性" → 肯定方向。
  assert.equal(conclusionDirection("结论：具备创造性", "本申请具有创造性"), 1);
  // actual 无"创造性"方向表述 → 未表达。
  assert.equal(conclusionDirection("结论：具备创造性", "三步法分析…无明确结论"), 0);
});

test("conclusionDirection: actual 无标记行 → 0（结论方向未表达）", () => {
  assert.equal(conclusionDirection("结论：具备创造性", "该权利要求具备创造性"), 1, "自然表述可判定");
  assert.equal(conclusionDirection("结论：具备创造性", "三步法分析…无明确结论"), 0);
});

test("conclusionDirection: expected 无标记或解析失败 → 1（旧 suite 不回归）", () => {
  assert.equal(conclusionDirection("不具备新颖性", "任意输出"), 1);
  assert.equal(conclusionDirection("修改方式：删除原独立权利要求", "三步法分析报告"), 1);
  assert.equal(conclusionDirection("", ""), 1);
  // 矛盾 expected（异常数据）→ 不判。
  assert.equal(conclusionDirection("结论：具备创造性\n结论：不具备创造性", "结论：具备创造性"), 1);
});

test("conclusionDirection: 正文含'创造'但不带标记行不参与方向（P1-3 验收）", () => {
  // expected 有标记、actual 正文含"创造性"表述但无"结论："行 → 方向未表达 → 0。
  assert.equal(conclusionDirection("结论：具备创造性", "创造性判断：区别特征非显而易见"), 0);
});
