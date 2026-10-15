import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPercent, formatFen, parseYuan, reducedFen, sumFen } from "../../../src/patent/fees/money.js";

describe("patent/fees/money", () => {
  it("解析十进制元金额", () => {
    assert.equal(parseYuan("900"), 90000);
    assert.equal(parseYuan("94.5"), 9450);
    assert.equal(parseYuan("94.50"), 9450);
    assert.equal(parseYuan("0"), 0);
    assert.equal(parseYuan("0.01"), 1);
  });

  it("拒绝不是十进制元金额的写法", () => {
    for (const bad of ["", " 900", "900 ", "-1", "+1", "1e3", "1.234", ".5", "900元", "1,000", "０１"]) {
      assert.equal(parseYuan(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
    }
  });

  it("格式化：恒两位小数", () => {
    assert.equal(formatFen(90000), "900.00");
    assert.equal(formatFen(9450), "94.50");
    assert.equal(formatFen(1), "0.01");
    assert.equal(formatFen(0), "0.00");
    assert.equal(formatFen(-450), "-4.50");
  });

  it("金额算术不经过浮点：0.1 + 0.2 类误差在分上不出现", () => {
    // 0.10 + 0.20 元
    assert.equal(formatFen(sumFen([10, 20])), "0.30");
    // 官费表里的典型组合
    assert.equal(formatFen(sumFen([90000, 5000, 30000])), "1250.00");
  });

  it("百分数四舍五入到分", () => {
    assert.equal(applyPercent(90000, 15), 13500);
    assert.equal(applyPercent(90000, 30), 27000);
    assert.equal(applyPercent(90000, 5), 4500);
    // 0.005 元的一半进位到 0.01 元
    assert.equal(formatFen(applyPercent(1, 50)), "0.01");
  });

  it("reducedFen：「减缴 85%」= 只缴 15%", () => {
    assert.equal(formatFen(reducedFen(90000, 85)), "135.00");
    assert.equal(formatFen(reducedFen(50000, 85)), "75.00");
    assert.equal(formatFen(reducedFen(90000, 70)), "270.00");
    // 与官费标准的减缴栏逐格一致（发明申请费 900 → 135 / 270）
    assert.equal(formatFen(reducedFen(parseYuan("900") ?? 0, 85)), "135.00");
    assert.equal(formatFen(reducedFen(parseYuan("900") ?? 0, 70)), "270.00");
  });

  it("年费与滞纳金的标准组合：900 × 5% × 5 个月 = 225.00", () => {
    const monthly = applyPercent(parseYuan("900") ?? 0, 5);
    assert.equal(formatFen(monthly * 5), "225.00");
  });
});
