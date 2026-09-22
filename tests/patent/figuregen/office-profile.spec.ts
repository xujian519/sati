/**
 * src/patent/figuregen/office-profile — 法域档案测试（W1-1）。
 *
 * 档案是"纸面常数 + 图号 + 页码"的单一事实源，故测试断言三件事：
 * ① 每个数值对得上**已核验条文**（含两处刻意的取值规则：公制/英制并列取较大值、无条文数值不编）；
 * ② 档案内部自洽（派生可印区不超条文自陈的可用面上限）；
 * ③ 条件性（图号是否出现、页码体例）由档案回答，渲染与核验共用。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_OFFICES,
  figureCaption,
  minCharHeight,
  officeForJurisdiction,
  officeProfile,
  printableArea,
  profileForJurisdiction,
  sheetNumberText,
  shouldRenderCaption,
} from "../../../src/patent/figuregen/office-profile.js";

test("档案：只列已核验法域（EPO 缺席），且每个法域都带条文出处", () => {
  assert.deepEqual([...TARGET_OFFICES], ["cnipa", "pct", "uspto"]);
  assert.ok(!(TARGET_OFFICES as readonly string[]).includes("epo"), "EPO 未核验，不得进档案");
  for (const office of TARGET_OFFICES) {
    const profile = officeProfile(office);
    assert.ok(profile.provisions.length >= 5, `${office} 的条文出处偏少（${profile.provisions.length}）`);
    assert.ok(
      profile.provisions.some(provision => /指南|CFR|PCT|Rule|Section/u.test(provision)),
      `${office} 的出处须含条文标识`,
    );
  }
});

test("档案：纸面常数逐条对上已核验条文（含公制/英制并列取较大值）", () => {
  const cnipa = officeProfile("cnipa");
  assert.deepEqual(cnipa.paper, { widthMm: 210, heightMm: 297 });
  // 指南五部一章 4.2（A4）/ 4.3（页边距）
  assert.deepEqual(cnipa.margins, { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 15 });
  assert.equal(cnipa.minCharHeightMm, undefined, "CN 无附图专有的字高条文");
  assert.equal(cnipa.practicalMinCharHeightMm, 2.0);

  // PCT Rule 11.5（A4）/ 11.6(c)（最小页边距 top 2.5 / left 2.5 / right 1.5 / bottom 1 cm）
  assert.deepEqual(officeProfile("pct").margins, { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 10 });
  assert.equal(officeProfile("pct").minCharHeightMm, 3.2, "PCT Rule 11.13(h) 的数字与字母不得低于 0.32cm");

  // 37 CFR 1.84(g)：top/left ≥2.5cm(1 inch)、right ≥1.5cm(5/8 inch)、bottom ≥1.0cm(3/8 inch)
  // ⇒ 公制与英制并列时取较大值（1 inch=25.4mm、5/8 inch=15.875mm；3/8 inch=9.525mm < 1.0cm）
  assert.deepEqual(officeProfile("uspto").margins, { topMm: 25.4, leftMm: 25.4, rightMm: 15.875, bottomMm: 10 });
  assert.equal(officeProfile("uspto").minCharHeightMm, 3.2, "37 CFR 1.84(p)(3) 的 .32cm");
});

test("档案：派生可印区不超条文自陈的可用面上限（内在一致性）", () => {
  // A4 上的可用面（sight）：PCT Rule 11.6(c) 26.2×17.0cm；37 CFR 1.84(g) 17.0×26.2cm
  for (const office of TARGET_OFFICES) {
    const area = printableArea(officeProfile(office));
    assert.ok(area.widthMm <= 170 + 1e-9, `${office} 可印宽 ${area.widthMm}mm 超出条文上限 170mm`);
    assert.ok(area.heightMm <= 262 + 1e-9, `${office} 可印高 ${area.heightMm}mm 超出条文上限 262mm`);
  }
  assert.deepEqual(printableArea(officeProfile("pct")), { widthMm: 170, heightMm: 262 });
  // CN 指南五部一章 4.3 的页边距派生 170×257mm
  assert.deepEqual(printableArea(officeProfile("cnipa")), { widthMm: 170, heightMm: 257 });
});

test("档案：辖区 → 档案键（未知取值回落 cn，不静默换成别的法域）", () => {
  assert.equal(officeForJurisdiction("cn"), "cnipa");
  assert.equal(officeForJurisdiction("us"), "uspto");
  assert.equal(officeForJurisdiction("pct"), "pct");
  assert.equal(officeForJurisdiction(), "cnipa");
  assert.equal(profileForJurisdiction().office, "cnipa");
});

test("图号：写法按档案、条件性按图幅数（CN 单幅也编号；PCT/US 单幅不编号）", () => {
  assert.equal(figureCaption(officeProfile("cnipa"), 2, 1), "图2");
  assert.equal(figureCaption(officeProfile("cnipa"), 2, 3), "图2");
  assert.equal(figureCaption(officeProfile("pct"), 2, 3), "Fig. 2");
  assert.equal(figureCaption(officeProfile("uspto"), 2, 3), "FIG. 2");
  assert.equal(figureCaption(officeProfile("pct"), 1, 1), undefined);
  assert.equal(figureCaption(officeProfile("uspto"), 1, 1), undefined);
  assert.equal(shouldRenderCaption(officeProfile("uspto"), 1), false);
  assert.equal(shouldRenderCaption(officeProfile("cnipa"), 1), true);
});

test("页码：CN 顺序阿拉伯数字；PCT/US 斜线分数（AI 207(b)(iii) / 37 CFR 1.84(t)）", () => {
  assert.equal(sheetNumberText(officeProfile("cnipa"), 2, 3), "2");
  assert.equal(sheetNumberText(officeProfile("pct"), 2, 3), "2/3");
  assert.equal(sheetNumberText(officeProfile("uspto"), 1, 3), "1/3");
});

test("字高下限：条文数值优先，无条文时给实践下限并标注来源性质", () => {
  assert.deepEqual(minCharHeight(officeProfile("uspto")), { mm: 3.2, basis: "statute" });
  assert.deepEqual(minCharHeight(officeProfile("pct")), { mm: 3.2, basis: "statute" });
  assert.deepEqual(minCharHeight(officeProfile("cnipa")), { mm: 2.0, basis: "practice" });
});

test("档案实例共享且不可就地改写（防调用方污染全局档案）", () => {
  const first = officeProfile("cnipa");
  const second = officeProfile("cnipa");
  assert.equal(first, second, "同一档案键应返回同一实例");
  assert.throws(() => {
    (first as { captionOnlyWhenMultiple: boolean }).captionOnlyWhenMultiple = true;
  }, "冻结的档案不得可写");
});
