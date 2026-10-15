import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CalendarDateError,
  formatCalendarDate,
  parseCalendarDate,
  type CalendarDate,
} from "../../../src/patent/deadline/calendar.js";
import { DeliveryInputError, resolveDeliveryDate, resolveDeliveryMode } from "../../../src/patent/deadline/delivery.js";

const d = (text: string): CalendarDate => parseCalendarDate(text);

describe("patent/deadline/delivery", () => {
  it("省略送达方式时按电子送达", () => {
    assert.equal(resolveDeliveryMode({}), "electronic");
    assert.equal(resolveDeliveryMode({ mode: "postal" }), "postal");
  });

  describe("电子送达（细则第 4 条第 7 款）", () => {
    it("**不加 15 日**：只给发文日时送达日就是发文日", () => {
      const resolved = resolveDeliveryDate({ mode: "electronic", dispatchDate: d("2026-09-01") });
      assert.equal(formatCalendarDate(resolved.date), "2026-09-01");
      assert.match(resolved.basis, /不加15日/);
    });

    it("这是漏期头号成因：若误加 15 日会得到 2026-09-16", () => {
      const resolved = resolveDeliveryDate({ mode: "electronic", dispatchDate: d("2026-09-01") });
      assert.notEqual(formatCalendarDate(resolved.date), "2026-09-16");
    });

    it("有进入日证据时以进入日为准", () => {
      const resolved = resolveDeliveryDate({
        mode: "electronic",
        dispatchDate: d("2026-09-01"),
        enteredDate: d("2026-09-03"),
      });
      assert.equal(formatCalendarDate(resolved.date), "2026-09-03");
    });

    it("进入日与发文日不一致时给出复核提示（细则未规定此时如何推定）", () => {
      const resolved = resolveDeliveryDate({
        mode: "electronic",
        dispatchDate: d("2026-09-01"),
        enteredDate: d("2026-09-03"),
      });
      assert.ok(resolved.caveat !== undefined);
      assert.match(resolved.caveat ?? "", /进入日与发文日不一致/);
    });

    it("两者一致时不产生提示", () => {
      const resolved = resolveDeliveryDate({
        mode: "electronic",
        dispatchDate: d("2026-09-01"),
        enteredDate: d("2026-09-01"),
      });
      assert.equal(resolved.caveat, undefined);
    });

    it("既无发文日也无进入日时 fail-loud", () => {
      assert.throws(() => resolveDeliveryDate({ mode: "electronic" }), DeliveryInputError);
    });
  });

  describe("邮寄送达（细则第 4 条第 4 款）", () => {
    it("只给发文日时以「发出之日起满 15 日」推定", () => {
      const resolved = resolveDeliveryDate({ mode: "postal", dispatchDate: d("2026-10-15") });
      assert.equal(formatCalendarDate(resolved.date), "2026-10-30");
    });

    it("推定送达日**遇休假日不顺延**（只有期限届满日才顺延）", () => {
      // 2026-10-23 是周五，+15 日 = 2026-11-07（周六）。推定日不顺延，故就是周六。
      const resolved = resolveDeliveryDate({ mode: "postal", dispatchDate: d("2026-10-23") });
      assert.equal(formatCalendarDate(resolved.date), "2026-11-07");
    });

    it("当事人举证实际收到日时以实际收到日为准", () => {
      const resolved = resolveDeliveryDate({
        mode: "postal",
        dispatchDate: d("2026-10-15"),
        actualReceiptDate: d("2026-10-18"),
      });
      assert.equal(formatCalendarDate(resolved.date), "2026-10-18");
    });

    it("两个字段都缺时 fail-loud", () => {
      assert.throws(() => resolveDeliveryDate({ mode: "postal" }), DeliveryInputError);
    });
  });

  describe("直接送交与公告送达", () => {
    it("直接送交以交付日为送达日", () => {
      const resolved = resolveDeliveryDate({ mode: "personal", handedOverDate: d("2026-03-02") });
      assert.equal(formatCalendarDate(resolved.date), "2026-03-02");
    });

    it("直接送交缺交付日时 fail-loud", () => {
      assert.throws(() => resolveDeliveryDate({ mode: "personal" }), DeliveryInputError);
    });

    it("公告送达自公告之日起满 1 个月（含月末规则）", () => {
      const resolved = resolveDeliveryDate({ mode: "publication", publicationDate: d("2026-01-31") });
      assert.equal(formatCalendarDate(resolved.date), "2026-02-28");
    });

    it("公告送达缺公告日时 fail-loud", () => {
      assert.throws(() => resolveDeliveryDate({ mode: "publication" }), DeliveryInputError);
    });
  });

  it("坏日期值 fail-loud（不静默算成 NaN 日期）", () => {
    assert.throws(
      () => resolveDeliveryDate({ mode: "electronic", dispatchDate: { year: Number.NaN, month: 1, day: 1 } }),
      CalendarDateError,
    );
    assert.throws(
      () => resolveDeliveryDate({ mode: "postal", actualReceiptDate: { year: 2026, month: 2, day: 30 } }),
      CalendarDateError,
    );
  });
});
