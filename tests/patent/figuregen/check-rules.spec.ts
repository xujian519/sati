/**
 * src/patent/figuregen/check-rules — 规则注册表的结构性测试。
 *
 * 21 条规则原先共用一个 503 行的函数作用域（改一条必须通读 500 行），拆分后本文件守的是
 * **别再塞回去**：注册表必须覆盖全部规则号、id 不重复、顺序稳定，且每条规则对同一份上下文
 * 都能**独立跑完**——一条规则若依赖另一条的中间产物，单独跑就会抛错或空转。
 *
 * 判据本身的行为由 `check.spec.ts` / `check-numbering.spec.ts` / `check-p1.spec.ts` /
 * `wording.spec.ts` 逐条覆盖，本文件只管结构。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildRuleContext } from "../../../src/patent/figuregen/check-context.js";
import { FIGURE_RULES } from "../../../src/patent/figuregen/check-rules.js";
import type { FigureCheckRuleId } from "../../../src/patent/figuregen/check.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

/**
 * 注册表顺序是**契约**（报告里的发现顺序与既有 spec 的断言都按它排列）。
 * V6 不在表内：黑白线条是渲染器构造期不变式，由 render-svg 单测保证。
 * 新增规则应追加到末尾（而不是按号码插入）——改序会让报告与人工习惯同时失配。
 */
const EXPECTED_ORDER: readonly FigureCheckRuleId[] = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V18",
  "V19",
  "V20",
  "V21",
  "V10",
  "V11",
  "V7",
  "V8",
  "V9",
  "V12",
  "V13",
  "V14",
  "V15",
  "V16",
  "V17",
];

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [{ id: "a", label: "处理模块(20)", ref: 20 }],
  edges: [],
};

test("注册表覆盖全部规则号（V6 除外）且顺序稳定", () => {
  assert.deepEqual(
    FIGURE_RULES.map(rule => rule.id),
    [...EXPECTED_ORDER],
  );
  assert.equal(new Set(FIGURE_RULES.map(rule => rule.id)).size, FIGURE_RULES.length, "规则号不得重复");
});

test("每条规则对空输入都能独立跑完（不依赖另一条规则的中间产物）", () => {
  const ctx = buildRuleContext([], "", {});
  for (const rule of FIGURE_RULES) {
    assert.doesNotThrow(() => rule.run(ctx), `${rule.id} 无法独立运行`);
  }
});

test("每条规则对典型输入都能独立跑完，且只产出自己的规则号", () => {
  const ctx = buildRuleContext([FIG], "处理模块(20)对数据进行处理。", { jurisdiction: "cn" });
  for (const rule of FIGURE_RULES) {
    const findings = rule.run(ctx);
    for (const finding of findings) {
      assert.equal(finding.rule, rule.id, `${rule.id} 产出了别的规则号`);
      assert.ok(finding.message.length > 0, `${rule.id} 的发现缺少说明`);
    }
  }
});

test("规则是纯函数：同一上下文跑两次结果相同（确定性）", () => {
  const ctx = buildRuleContext([FIG], "处理模块(20)对数据进行处理。", { jurisdiction: "cn" });
  for (const rule of FIGURE_RULES) {
    assert.deepEqual(rule.run(ctx), rule.run(ctx), `${rule.id} 不确定`);
  }
});

test("上下文里没有跨规则共享的可变局部量（注册表可重排而不改变单条结论）", () => {
  // 反序跑一遍：每条规则的产出必须与正序时逐字节相同——顺序只影响**报告里发现的排列**，
  // 不影响任何一条规则自己的结论（这是"拆开之后规则之间不互相牵动"的可执行定义）。
  const ctx = buildRuleContext([FIG], "处理模块(20)对数据进行处理。", { jurisdiction: "cn" });
  const forward = new Map(FIGURE_RULES.map(rule => [rule.id, rule.run(ctx)]));
  for (const rule of [...FIGURE_RULES].reverse()) {
    assert.deepEqual(rule.run(ctx), forward.get(rule.id), `${rule.id} 的结论受运行顺序影响`);
  }
});
