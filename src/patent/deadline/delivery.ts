/**
 * src/patent/deadline/delivery — 送达日认定（专利法实施细则第 4 条）。
 *
 * 送达是**每一个指定期限、以及授权/驳回期限的起算点**，所以这里把日期算明白并连同**所依据
 * 的规则**一起返回（`basis` 进报告，供复核）。
 *
 * 细则第 4 条把四种送达方式的日期来源分得很清楚：
 *
 * | 方式 | 送达日 |
 * |---|---|
 * | 电子（第 7 款） | 进入当事人认可的电子系统的日期 |
 * | 邮寄（第 4 款） | 自发出之日起满 15 日推定收到；当事人举证实际收到日的，以实际收到日为准 |
 * | 直接送交（第 5 款） | 交付日 |
 * | 公告（第 6 款） | 自公告之日起满 1 个月 |
 *
 * **实务要点（本模块存在的主要理由）**：只有**邮寄**才有「满 15 日」的推定。电子送达**没有**
 * 15 日邮路时间——沿用纸件时代的心算会少算半个月，是漏期的头号成因。CNIPA 自 2024-01-20 起
 * 全面适用修订后的细则第 4 条（[国家知识产权局 2024 年 1 月留言回复](https://www.cnipa.gov.cn/art/2024/2/20/art_707_357.html)）。
 *
 * 另：**推定送达日本身遇休假日不顺延**，只有「期限届满日」才顺延（细则第 5 条末句）。故邮寄的
 * `+15日` 在这里直接加，不调用工作日历。
 */

import { addCalendarDays, assertCalendarDate, type CalendarDate } from "./calendar.js";
import { periodEnd } from "./period.js";

/** 送达方式。 */
export type DeliveryMode = "electronic" | "postal" | "personal" | "publication";

/** 一份通知的送达记录（字段需求随 `mode` 而定）。 */
export type DeliveryInput = {
  mode: DeliveryMode;
  /** 通知书上的发文日（电子送达与邮寄都用）。 */
  dispatchDate?: CalendarDate;
  /** 文件进入当事人电子系统的日期（有证据时）。 */
  enteredDate?: CalendarDate;
  /** 当事人能够举证的实际收到日。 */
  actualReceiptDate?: CalendarDate;
  /** 直接送交的交付日。 */
  handedOverDate?: CalendarDate;
  /** 公告送达的公告日。 */
  publicationDate?: CalendarDate;
};

/** 调用方给出的送达记录；`mode` 可省略。 */
export type DeliveryRequest = Omit<DeliveryInput, "mode"> & { mode?: DeliveryMode };

/** 认定出的送达日与所依据的规则。 */
export type DeliveryDate = {
  date: CalendarDate;
  /** 所适用的规则（进报告，供追溯）。 */
  basis: string;
  /**
   * 需要复核的提示（Sati 新增）。目前只在「进入日与发文日不一致」时出现：细则第 4 条第 7 款
   * 只规定「以进入日为送达日」，未规定两者不一致时如何推定，故本次按进入日认定并显式提示复核。
   */
  caveat?: string;
};

/** 送达记录缺少该方式必需的字段时抛出。 */
export class DeliveryInputError extends Error {
  /**
   * @param message - 缺哪个字段。
   */
  constructor(message: string) {
    super(message);
    this.name = "DeliveryInputError";
  }
}

/**
 * 认定送达方式：用给出的方式，否则按**电子送达**。
 *
 * CNIPA 默认以电子形式送达，且电子送达以进入日为送达日（未举证时为发文日），故省略 `mode`
 * 得到的是「自发文日起算」的口径。
 * @param request - 送达记录。
 * @returns 要适用的送达方式。
 */
export function resolveDeliveryMode(request: DeliveryRequest): DeliveryMode {
  return request.mode ?? "electronic";
}

/** 校验记录里出现过的日期值（防止绕过解析器构造出的 NaN 日期静默通过）。 */
function assertSuppliedDates(request: DeliveryRequest): void {
  for (const key of [
    "dispatchDate",
    "enteredDate",
    "actualReceiptDate",
    "handedOverDate",
    "publicationDate",
  ] as const) {
    const value = request[key];
    if (value !== undefined) assertCalendarDate(value, key);
  }
}

/**
 * 认定一份通知的送达日。
 *
 * - `electronic`：有进入日证据时用进入日；否则按发文日（此时期限自发文日起算，**不加 15 日**）。
 * - `postal`：有实际收到日证据时用实际收到日；否则发文日 + 15 日（推定日不顺延）。
 * - `personal`：交付日。
 * - `publication`：公告日起满 1 个月。
 * @param request - 送达记录。
 * @returns 送达日与所依据的规则。
 * @throws DeliveryInputError 当该方式所需的字段缺失。
 * @throws CalendarDateError 当给出的日期不是真实存在的日期。
 */
export function resolveDeliveryDate(request: DeliveryRequest): DeliveryDate {
  assertSuppliedDates(request);
  switch (resolveDeliveryMode(request)) {
    case "electronic": {
      const { enteredDate, dispatchDate } = request;
      if (enteredDate === undefined && dispatchDate === undefined) {
        throw new DeliveryInputError("电子送达需要发文日（dispatchDate）或电子系统进入日（enteredDate）。");
      }
      const date = enteredDate ?? (dispatchDate as CalendarDate);
      const caveat =
        enteredDate !== undefined &&
        dispatchDate !== undefined &&
        (enteredDate.year !== dispatchDate.year ||
          enteredDate.month !== dispatchDate.month ||
          enteredDate.day !== dispatchDate.day)
          ? "进入日与发文日不一致：细则第4条第7款只规定以进入日为送达日，未规定不一致时的推定，本次按进入日认定，请按案卷证据复核。"
          : undefined;
      return {
        date,
        basis:
          enteredDate !== undefined
            ? "专利法实施细则第4条第7款：电子形式送达以进入当事人认可的电子系统的日期为送达日"
            : "专利法实施细则第4条第7款：电子形式送达以进入当事人认可的电子系统的日期为送达日；未举证进入日时以发文日认定（电子送达不加15日）",
        ...(caveat !== undefined ? { caveat } : {}),
      };
    }
    case "postal": {
      if (request.actualReceiptDate !== undefined) {
        return {
          date: request.actualReceiptDate,
          basis: "专利法实施细则第4条第4款：当事人举证证明实际收到日期的，以实际收到日为准",
        };
      }
      if (request.dispatchDate === undefined) {
        throw new DeliveryInputError("邮寄送达需要发文日（dispatchDate）或实际收到日（actualReceiptDate）。");
      }
      return {
        date: addCalendarDays(request.dispatchDate, 15),
        basis: "专利法实施细则第4条第4款：邮寄文件自发出之日起满15日推定为收到日（推定收到日遇休假日不顺延）",
      };
    }
    case "personal": {
      if (request.handedOverDate === undefined) {
        throw new DeliveryInputError("直接送交需要交付日（handedOverDate）。");
      }
      return { date: request.handedOverDate, basis: "专利法实施细则第4条第5款：直接送交的文件以交付日为送达日" };
    }
    case "publication": {
      if (request.publicationDate === undefined) {
        throw new DeliveryInputError("公告送达需要公告日（publicationDate）。");
      }
      return {
        date: periodEnd(request.publicationDate, { unit: "month", count: 1 }),
        basis: "专利法实施细则第4条第6款：公告送达自公告之日起满1个月视为已经送达",
      };
    }
  }
}
