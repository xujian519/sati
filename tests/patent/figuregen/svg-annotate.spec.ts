/**
 * src/patent/figuregen — 既有 SVG 附图参考标号追加与登记核对的测试。
 *
 * 测的是**契约**而非实现细节：追加形态是本仓惯例的「处理模块(20)」（无空格，与
 * `stripRefMark` / `normalizeRefLabel` 同一词法）、匹配是子串且大小写不敏感、每个图元至多
 * 被一个请求命中一次、未命中不静默丢弃（进 unmatched 且与 applied 互补）、输入未过安全门
 * 时抛 `SvgSafetyError`。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateSvgWithReferences,
  validateSvgReferences,
  type SvgReferenceRequest,
} from "../../../src/patent/figuregen/svg-annotate.js";
import { isSvgSafetyError } from "../../../src/patent/figuregen/svg-safety.js";

/** 两个图元的最小 SVG（属性刻意保留，用于验证"只改文本内容"）。 */
const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">',
  '<g id="n-a"><text x="10" y="20" font-size="12">处理模块</text></g>',
  '<g id="n-b"><text x="10" y="40" font-size="12">存储介质</text></g>',
  "</svg>",
].join("");

/** 断言被安全门拒绝且错误码为 `unsafe_svg`。 */
function assertRejectedAsUnsafe(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(isSvgSafetyError(error), `应为 SvgSafetyError，实际 ${String(error)}`);
    assert.equal(error.code, "unsafe_svg");
    return true;
  });
}

test("命中：按图元文本追加「(n)」形态的附图标记（无空格）", () => {
  const result = annotateSvgWithReferences(SVG, [{ text: "处理模块", numeral: 20 }]);
  assert.equal(result.applied, 1);
  assert.deepEqual(result.unmatched, []);
  assert.match(result.svg, />处理模块\(20\)<\/text>/u);
  // 未被请求命中的图元不得被牵动。
  assert.doesNotMatch(result.svg, /存储介质\(/u);
});

test("只改文本内容：其余结构与属性原样保留", () => {
  const result = annotateSvgWithReferences(SVG, [{ text: "处理模块", numeral: 20 }]);
  assert.equal(result.svg.replace("(20)", ""), SVG);
});

test("已含标号：不重复追加（不得出现「(20)(20)」）", () => {
  const svg = "<svg><text>处理模块(20)</text></svg>";
  const result = annotateSvgWithReferences(svg, [{ text: "处理模块", numeral: 20 }]);
  assert.equal(result.svg, svg);
  // 标号已在图面上：请求算命中（不是"没标上"），故不计入 unmatched。
  assert.equal(result.applied, 1);
  assert.deepEqual(result.unmatched, []);
});

test("已含标号：全角括号形态同样识别为已标注", () => {
  const svg = "<svg><text>处理模块（20）</text></svg>";
  const result = annotateSvgWithReferences(svg, [{ text: "处理模块", numeral: 20 }]);
  assert.equal(result.svg, svg);
  assert.equal(result.applied, 1);
});

test("未命中：进 unmatched（不静默丢弃），SVG 不变", () => {
  const result = annotateSvgWithReferences(SVG, [{ text: "不存在的部件", numeral: 30 }]);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.unmatched, [{ text: "不存在的部件", numeral: 30 }]);
  assert.equal(result.svg, SVG);
});

test("大小写不敏感：请求文本与图元文本大小写不同也命中", () => {
  const svg = "<svg><text>Sensor Module</text></svg>";
  const result = annotateSvgWithReferences(svg, [{ text: "sensor module", numeral: 10 }]);
  assert.equal(result.applied, 1);
  assert.match(result.svg, />Sensor Module\(10\)<\/text>/u);
});

test("子串匹配：请求文本是图元文本的一部分也命中", () => {
  const result = annotateSvgWithReferences(SVG, [{ text: "模块", numeral: 20 }]);
  assert.equal(result.applied, 1);
  assert.match(result.svg, />处理模块\(20\)<\/text>/u);
});

test("同一图元只命中一次：多个请求都匹配时取靠前者，其余进 unmatched", () => {
  const svg = "<svg><text>处理模块</text></svg>";
  const result = annotateSvgWithReferences(svg, [
    { text: "处理模块", numeral: 20 },
    { text: "模块", numeral: 30 },
  ]);
  assert.equal(result.applied, 1);
  assert.match(result.svg, />处理模块\(20\)<\/text>/u);
  assert.doesNotMatch(result.svg, /\(30\)/u);
  assert.deepEqual(result.unmatched, [{ text: "模块", numeral: 30 }]);
});

test("同一请求命中多个图元：同号标注（同一组成部分在图内多处出现）", () => {
  const svg = "<svg><text>处理模块</text><text>处理模块</text></svg>";
  const result = annotateSvgWithReferences(svg, [{ text: "处理模块", numeral: 20 }]);
  assert.equal(result.applied, 1);
  assert.equal(result.svg.match(/\(20\)/gu)?.length, 2);
});

test("嵌套标签：追加落在最后一个子元素内部（tspan）", () => {
  const svg = '<svg><text x="1" y="2"><tspan>处理模块</tspan></text></svg>';
  const result = annotateSvgWithReferences(svg, [{ text: "处理模块", numeral: 20 }]);
  assert.match(result.svg, /<tspan>处理模块\(20\)<\/tspan>/u);
});

test("无效请求：空文本与非正整数标记进 unmatched（不乱标）", () => {
  const result = annotateSvgWithReferences(SVG, [
    { text: "   ", numeral: 20 },
    { text: "处理模块", numeral: 0 },
  ]);
  assert.equal(result.applied, 0);
  assert.equal(result.unmatched.length, 2);
  assert.equal(result.svg, SVG);
});

test("applied 与 unmatched 互补：两者之和恒等于请求总数", () => {
  const requests: SvgReferenceRequest[] = [
    { text: "处理模块", numeral: 20 },
    { text: "存储介质", numeral: 30 },
    { text: "缺件", numeral: 40 },
  ];
  const result = annotateSvgWithReferences(SVG, requests);
  assert.equal(result.applied + result.unmatched.length, requests.length);
});

test("安全门：含 DOCTYPE / ENTITY / CDATA 的输入被拒（抛 SvgSafetyError）", () => {
  assertRejectedAsUnsafe(() =>
    annotateSvgWithReferences(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n${SVG}`, [
      { text: "处理模块", numeral: 20 },
    ]),
  );
  assertRejectedAsUnsafe(() =>
    annotateSvgWithReferences(`${SVG}\n<!ENTITY xxe SYSTEM "file:///etc/passwd">`, [{ text: "处理模块", numeral: 20 }]),
  );
  assertRejectedAsUnsafe(() =>
    annotateSvgWithReferences(`${SVG}<![CDATA[<script/>]]>`, [{ text: "处理模块", numeral: 20 }]),
  );
});

test("安全门：缺 <svg 根的输入被拒（不静默通过）", () => {
  assert.throws(
    () => annotateSvgWithReferences("<text>处理模块</text>", [{ text: "处理模块", numeral: 20 }]),
    (error: unknown) => {
      assert.ok(isSvgSafetyError(error), `应为 SvgSafetyError，实际 ${String(error)}`);
      assert.equal(error.code, "missing_svg_root");
      return true;
    },
  );
});

test("validate：报出图面上未登记的附图标记", () => {
  const svg = "<svg><text>处理模块(20)</text><text>存储介质(30)</text></svg>";
  assert.deepEqual(validateSvgReferences(svg, [20]).unknown, [30]);
  assert.deepEqual(validateSvgReferences(svg, [20, 30]).unknown, []);
  assert.deepEqual(validateSvgReferences(svg, []).unknown, [20, 30]);
});

test("validate：编号词前缀（图(1)/步骤(20)）不算附图标记", () => {
  const svg = "<svg><text>步骤(20)</text><text>图(1)</text><text>处理模块(20)</text></svg>";
  assert.deepEqual(validateSvgReferences(svg, []).unknown, [20]);
  assert.deepEqual(validateSvgReferences(svg, [20]).unknown, []);
});

test("validate：超过三位实务上限的数字不计入附图标记形态", () => {
  const svg = "<svg><text>年份(2024)</text><text>处理模块(20)</text></svg>";
  assert.deepEqual(validateSvgReferences(svg, [20]).unknown, []);
});

test("validate：安全门同样生效（DOCTYPE 输入被拒）", () => {
  assertRejectedAsUnsafe(() => validateSvgReferences(`<!DOCTYPE svg>\n${SVG}`, [20]));
});
