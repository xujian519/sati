import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearFeeTableCache, FeeTableError, loadFeeTable, parseFeeTable } from "../../../src/patent/fees/fees.js";

const ORIGIN = "/tmp/cn-fees.test.yaml";

/** 一条最小条目：只给 id / name 与调用方指定的其余字段。 */
function item(id: string, fields: string): string {
  return `  - id: ${id}\n    name: 甲\n${fields}`;
}

/** 一份最小可装载的索引；`items` 段整体替换。 */
function tableWith(items: string): string {
  return [
    "document: 测试索引",
    "currency: CNY",
    "reductionPercent:",
    "  single: 85",
    "  joint: 70",
    "reductionKinds:",
    "  - kind: individual",
    "    label: 个人",
    "    eligibility: 收入门槛",
    "items:",
    items,
  ].join("\n");
}

/** 一条合法的每件收费条目。 */
const PLAIN = "    trigger: filing\n    basis: per-case\n    amount: '10'";

describe("patent/fees/fees — 随包资产", () => {
  const table = loadFeeTable();

  it("可装载，条目非空且 id 唯一", () => {
    assert.ok(table.items.length >= 20, `条目数应不少于 20，实际 ${String(table.items.length)}`);
    const ids = table.items.map(entry => entry.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("凡有金额的条目必须带核验日期（没有核验日期的金额是未核验，不是默认已核验）", () => {
    const unverified = table.items.filter(entry => entry.amount !== null && entry.verifiedOn === null);
    assert.deepEqual(
      unverified.map(entry => entry.id),
      [],
    );
  });

  it("没有金额的条目必须写明理由，或者价格在 tiers 里", () => {
    const silent = table.items.filter(
      entry =>
        entry.amount === null &&
        entry.tiers.length === 0 &&
        (entry.unpriceableReason === undefined || entry.unpriceableReason.trim() === ""),
    );
    assert.deepEqual(
      silent.map(entry => entry.id),
      [],
    );
  });

  it("同名的年费条目按专利类型拆开，且档位覆盖到各自的专利权期限末", () => {
    const annualFees = table.items.filter(entry => entry.trigger === "annual-fee");
    assert.equal(annualFees.length, 3);
    const expected: Array<[string, number]> = [
      ["annual-fee", 20], // 发明：专利法第 42 条第 1 款 20 年
      ["annual-fee-utility-model", 10], // 实用新型：10 年
      ["annual-fee-design", 15], // 外观设计：15 年
    ];
    for (const [id, lastYear] of expected) {
      const entry = annualFees.find(candidate => candidate.id === id);
      assert.ok(entry !== undefined, `应有 ${id}`);
      const last = entry.tiers.reduce((max, tier) => Math.max(max, tier.toYear), 0);
      assert.equal(last, lastYear, `${id} 的档位应覆盖到第 ${String(lastYear)} 年度`);
      assert.equal(entry.reductionMaxYears, 10);
    }
  });

  it("减缴比例是单独 85% / 共同 70%，且三类资格各自有认定条件", () => {
    assert.deepEqual(table.reductionPercent, { single: 85, joint: 70 });
    assert.deepEqual(
      table.reductionKinds.map(entry => entry.kind),
      ["individual", "enterprise", "institution"],
    );
    assert.match(
      table.reductionKinds.find(entry => entry.kind === "individual")?.eligibility ?? "",
      /5000 元（年 6 万元）/,
    );
    assert.match(table.reductionKinds.find(entry => entry.kind === "enterprise")?.eligibility ?? "", /100 万元/);
  });

  it("滞纳金：法定窗口 6 个月，官方参考表已列 5 个月", () => {
    const annual = table.items.find(entry => entry.id === "annual-fee");
    assert.ok(annual?.latePayment !== undefined);
    assert.equal(annual.latePayment.monthlyPercent, 5);
    assert.equal(annual.latePayment.maxMonths, 6);
    assert.equal(annual.latePayment.tabulatedMonths, 5);
  });
});

describe("patent/fees/fees — 资产畸形一律装载失败", () => {
  it("文件不存在", () => {
    clearFeeTableCache();
    assert.throws(() => loadFeeTable("/tmp/definitely-not-a-fee-table.yaml"), FeeTableError);
  });

  it("YAML 语法错误", () => {
    assert.throws(() => parseFeeTable("items: [\n", ORIGIN), FeeTableError);
  });

  it("根节点不是映射", () => {
    assert.throws(() => parseFeeTable("- 1\n- 2\n", ORIGIN), FeeTableError);
  });

  it("items 为空数组（空表会把每个案子都报成已计价）", () => {
    assert.throws(
      () => parseFeeTable(tableWith("  []"), ORIGIN),
      (error: unknown) => error instanceof FeeTableError && /items 必须是非空数组/.test(error.message),
    );
  });

  it("id 重复", () => {
    const source = tableWith(`${item("same", PLAIN)}\n${item("same", PLAIN)}`);
    assert.throws(() => parseFeeTable(source, ORIGIN), /条目 id 重复：same/);
  });

  it("未知 trigger", () => {
    const source = tableWith(item("a", "    trigger: nonsense\n    basis: per-case\n    amount: '10'"));
    assert.throws(() => parseFeeTable(source, ORIGIN), /a\.trigger 必须是/);
  });

  it("per-claim-beyond 缺 freeUnits", () => {
    const source = tableWith(item("a", "    trigger: filing\n    basis: per-claim-beyond\n    amount: '10'"));
    assert.throws(() => parseFeeTable(source, ORIGIN), /必须给出 freeUnits/);
  });

  it("per-case 带了 freeUnits", () => {
    const source = tableWith(
      item("a", "    trigger: filing\n    basis: per-case\n    freeUnits: 10\n    amount: '10'"),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /不得给出 freeUnits/);
  });

  it("非年费条目带 tiers", () => {
    const source = tableWith(
      item("a", `${PLAIN}\n    tiers:\n      - fromYear: 1\n        toYear: 3\n        amount: '1'`),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /不得给出 tiers/);
  });

  it("tiers 区间重叠", () => {
    const source = tableWith(
      item(
        "a",
        "    trigger: annual-fee\n    basis: per-annuity-year\n    tiers:\n      - fromYear: 1\n        toYear: 5\n" +
          "        amount: '1'\n      - fromYear: 4\n        toYear: 8\n        amount: '2'",
      ),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /年度区间重叠/);
  });

  it("tiers 的 toYear 早于 fromYear", () => {
    const source = tableWith(
      item(
        "a",
        "    trigger: annual-fee\n    basis: per-annuity-year\n    tiers:\n      - fromYear: 5\n        toYear: 1\n        amount: '1'",
      ),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /toYear 不得早于 fromYear/);
  });

  it("没有金额又没有理由（「留空」不是一种状态）", () => {
    const source = tableWith(item("a", "    trigger: filing\n    basis: per-case\n    reducible: false"));
    assert.throws(() => parseFeeTable(source, ORIGIN), /没有金额/);
  });

  it("金额不是合法十进制元", () => {
    for (const bad of ["'-1'", "'1.234'", "'1e3'", "'abc'", "'￥10'"]) {
      assert.throws(
        () =>
          parseFeeTable(tableWith(item("a", `    trigger: filing\n    basis: per-case\n    amount: ${bad}`)), ORIGIN),
        FeeTableError,
        `应拒绝 ${bad}`,
      );
    }
  });

  it("数字金额被规范成字符串", () => {
    const parsed = parseFeeTable(
      tableWith(item("a", "    trigger: filing\n    basis: per-case\n    amount: 94.5")),
      ORIGIN,
    );
    assert.equal(parsed.items[0]?.amount, "94.5");
  });

  it("减缴比例方向反了（共同申请不能比单独更优惠）", () => {
    const source = tableWith(item("a", PLAIN)).replace("  joint: 70", "  joint: 90");
    assert.throws(() => parseFeeTable(source, ORIGIN), /joint（90）应小于 single（85）/);
  });

  it("百分数越界", () => {
    const source = tableWith(item("a", PLAIN)).replace("  single: 85", "  single: 0");
    assert.throws(() => parseFeeTable(source, ORIGIN), /reductionPercent\.single 必须是 \(0, 100\]/);
  });

  it("reductionKinds 重复声明", () => {
    const source = tableWith(item("a", PLAIN)).replace(
      "  - kind: individual",
      "  - kind: individual\n    label: 个人\n    eligibility: 收入门槛\n  - kind: individual",
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /重复声明了 individual/);
  });

  it("非年费条目带 latePayment", () => {
    const source = tableWith(
      item("a", `${PLAIN}\n    latePayment:\n      monthlyPercent: 5\n      maxMonths: 6\n      tabulatedMonths: 5`),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /不得给出 latePayment/);
  });

  it("tabulatedMonths 超过 maxMonths", () => {
    const source = tableWith(
      item(
        "a",
        "    trigger: annual-fee\n    basis: per-annuity-year\n    amount: '10'\n    latePayment:\n" +
          "      monthlyPercent: 5\n      maxMonths: 3\n      tabulatedMonths: 6",
      ),
    );
    assert.throws(() => parseFeeTable(source, ORIGIN), /不得超过 maxMonths/);
  });

  it("日期字段必须是 YYYY-MM-DD（避免被 YAML 解析成别的类型）", () => {
    const source = tableWith(item("a", `${PLAIN}\n    publishedOn: 2024-8-6`));
    assert.throws(() => parseFeeTable(source, ORIGIN), /必须是 YYYY-MM-DD/);
  });
});
