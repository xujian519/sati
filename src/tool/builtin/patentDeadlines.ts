import {
  CalendarDateError,
  formatCalendarDate,
  parseCalendarDate,
  type CalendarDate,
} from "../../patent/deadline/calendar.js";
import { DeliveryInputError, type DeliveryMode, type DeliveryRequest } from "../../patent/deadline/delivery.js";
import {
  DeadlineQueryError,
  evaluateDeadlines,
  type DeadlineQuery,
  type DeadlineReport,
  type NoticeInput,
  type NoticeKind,
  type PatentKind,
} from "../../patent/deadline/statutes.js";
import { renderDeadlineReport } from "../../patent/deadline/report.js";
import { loadWorkCalendar, WorkCalendarError } from "../../patent/deadline/work-calendar.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * patent_deadlines — 中国专利法定期限/指定期限计算（A3）。
 *
 * 为什么需要它：期限是专利实务里**唯一不能出错的算术**——算错一天就是一个案子的权利。模型自己
 * 推日期（月份进位、月末规则、法定休假日顺延、送达日口径）几乎必然出错，所以把这件事变成**机械
 * 可核算**的判据。
 *
 * ## 三条边界（工具描述里对模型明说，避免把降级当结论）
 *
 * 1. **不以固定年数代替送达日**：授权、驳回、审查意见的期限自**送达**起算。没有送达记录时本
 *    工具返回 `pending` 并指名缺哪个输入，不会拿「申请日起 N 年」顶上。
 * 2. **电子送达不加 15 日**：细则第 4 条第 7 款以进入电子系统之日为送达日；只有**邮寄**才有
 *    「自发出之日起满 15 日推定收到」（第 4 款）。沿用纸件时代的心算会**少算半个月**。
 * 3. **日历未覆盖年份不给判决值**：要办事的期限降级为 `pending`；参考性期限只给「仅按周末
 *    顺延」的**下界**并显式标出。两者都不会被呈现成已核验的正常届满日。
 */

/** 默认的「临近」阈值（天）：届满日距今不超过该值时报 urgent。 */
const DEFAULT_REMINDER_LEAD_DAYS = 30;

/** 资产缺失时的降级码（构建/部署问题，不是用户配置问题）。 */
const CALENDAR_ASSET_HINT =
  "工作日历资产缺失或畸形（应为 assets/patent/work-calendar/cn-holidays.yaml；" +
  "构建产物在 dist/assets/patent/work-calendar/，由 scripts/copy-build-assets.mjs 拷贝）。" +
  "期限届满日的顺延依赖该资产，缺失时无法给出判决值。";

export type PatentDeadlinesNoticeInput = {
  kind: NoticeKind;
  mode?: DeliveryMode;
  /** 通知书上的发文日（电子送达与邮寄用）。 */
  dispatchDate?: string;
  /** 文件进入电子系统的日期（有证据时）。 */
  enteredDate?: string;
  /** 当事人举证的实际收到日。 */
  actualReceiptDate?: string;
  /** 直接送交的交付日。 */
  handedOverDate?: string;
  /** 公告送达的公告日。 */
  publicationDate?: string;
  /** 通知书自身指定的期限月数（覆盖通常长度）。 */
  designatedMonths?: number;
};

export type PatentDeadlinesInput = {
  /** 专利类型：invention=发明、utility-model=实用新型、design=外观设计。 */
  kind: PatentKind;
  /** 申请日（YYYY-MM-DD）；国际申请填国际申请日。 */
  filingDate: string;
  /** 是否主张优先权（必须显式给出，不从有没有填优先权日推断）。 */
  claimsPriority: boolean;
  /** 优先权日（YYYY-MM-DD）；claimsPriority 为 true 时必需。 */
  priorityDate?: string;
  /** 是否为 PCT 进入中国国家阶段的申请。 */
  isPctNationalPhase?: boolean;
  /** 授权公告日（YYYY-MM-DD）；决定授权当年所处专利年度与年费序号。 */
  authorizationPublicationDate?: string;
  /** 本案收到的、会启动期限的通知。 */
  notices?: PatentDeadlinesNoticeInput[];
  /** 是否应用细则第 5 条顺延：apply（默认）| omit。 */
  restDayRule?: "apply" | "omit";
  /** 出具报告的基准日（YYYY-MM-DD）；缺省取服务器当天，给出后报告可复现。 */
  today?: string;
};

export type PatentDeadlinesOutput = {
  kind: PatentKind;
  filingDate: string;
  today: string;
  claimsPriority: boolean;
  priorityDate?: string;
  restDayRule: "apply" | "omit";
  calendarCoveredYears: number[];
  computed: DeadlineReport["computed"];
  pending: DeadlineReport["pending"];
  /** 与结构化字段同源的 Markdown 报告。 */
  report: string;
};

/** 取服务器当天（本地时区），仅工具层读时钟；求值器一律用调用方给的日期。 */
function systemToday(): CalendarDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** 把入参里的日期串解析为日历日期，出错时抛出带字段名的可读错误。 */
function parseDateField(value: string, label: string): CalendarDate {
  try {
    return parseCalendarDate(value);
  } catch (error) {
    if (error instanceof CalendarDateError) {
      throw new DeadlineQueryError(
        `${label} 不是有效日期：${JSON.stringify(value)}（需要 YYYY-MM-DD 且为真实存在的日期）。`,
      );
    }
    throw error;
  }
}

/** 把入参的送达记录转成求值用的形态（日期串 → 日历日期）。 */
function toDeliveryRequest(notice: PatentDeadlinesNoticeInput, label: string): DeliveryRequest {
  const request: DeliveryRequest = notice.mode !== undefined ? { mode: notice.mode } : {};
  if (notice.dispatchDate !== undefined)
    request.dispatchDate = parseDateField(notice.dispatchDate, `${label}.dispatchDate`);
  if (notice.enteredDate !== undefined)
    request.enteredDate = parseDateField(notice.enteredDate, `${label}.enteredDate`);
  if (notice.actualReceiptDate !== undefined) {
    request.actualReceiptDate = parseDateField(notice.actualReceiptDate, `${label}.actualReceiptDate`);
  }
  if (notice.handedOverDate !== undefined) {
    request.handedOverDate = parseDateField(notice.handedOverDate, `${label}.handedOverDate`);
  }
  if (notice.publicationDate !== undefined) {
    request.publicationDate = parseDateField(notice.publicationDate, `${label}.publicationDate`);
  }
  return request;
}

/** 组装求值输入。 */
function toQuery(input: PatentDeadlinesInput): DeadlineQuery {
  const notices: NoticeInput[] = (input.notices ?? []).map((notice, index) => {
    const label = `notices[${String(index)}]`;
    return {
      kind: notice.kind,
      delivery: toDeliveryRequest(notice, label),
      ...(notice.designatedMonths !== undefined ? { designatedMonths: notice.designatedMonths } : {}),
    };
  });
  return {
    kind: input.kind,
    filingDate: parseDateField(input.filingDate, "filingDate"),
    claimsPriority: input.claimsPriority,
    ...(input.priorityDate !== undefined ? { priorityDate: parseDateField(input.priorityDate, "priorityDate") } : {}),
    ...(input.isPctNationalPhase !== undefined ? { isPctNationalPhase: input.isPctNationalPhase } : {}),
    ...(input.authorizationPublicationDate !== undefined
      ? {
          authorizationPublicationDate: parseDateField(
            input.authorizationPublicationDate,
            "authorizationPublicationDate",
          ),
        }
      : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(input.restDayRule !== undefined ? { restDayRule: input.restDayRule } : {}),
    today: input.today !== undefined ? parseDateField(input.today, "today") : systemToday(),
  };
}

/** 工具定义。 */
export function createPatentDeadlinesTool(): SatiToolDefinition<PatentDeadlinesInput, PatentDeadlinesOutput> {
  return {
    name: "patent_deadlines",
    title: "Patent Deadlines",
    description:
      "计算中国专利的法定期限与指定期限（申请费、实审请求、办登与分案、公告后年费、优先权、PCT 进入国家阶段、" +
      "答复一通/后续通知、复审请求），输出期限本体届满日、应用细则第5条休假日顺延后的届满日、剩余天数与状态，" +
      "并附法条依据。三条边界：①以通知送达起算的期限必须有送达记录，否则返回 pending 并指名缺哪个输入，" +
      "不以申请日起的固定年数代替；②电子送达以进入电子系统之日（未举证时为发文日）为送达日，不加15日，" +
      "只有邮寄才有满15日推定；③工作日历未覆盖的年份，要办事的期限降级为 pending、参考性期限只给按周末顺延的下界。" +
      "起草答复、缴费、办登前先用本工具核对期限，不要自行推算日期。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["invention", "utility-model", "design"],
          description: "专利类型：invention=发明、utility-model=实用新型、design=外观设计",
        },
        filingDate: { type: "string", description: "申请日（YYYY-MM-DD）；国际申请填国际申请日" },
        claimsPriority: {
          type: "boolean",
          description: "是否主张优先权（必须显式给出：声明主张却没给优先权日、或给了优先权日却声明不主张，都会报错）",
        },
        priorityDate: { type: "string", description: "优先权日（YYYY-MM-DD）；claimsPriority 为 true 时必需" },
        isPctNationalPhase: {
          type: "boolean",
          description: "是否为 PCT 进入中国国家阶段的申请（true 时给 30/32 个月期限）",
        },
        authorizationPublicationDate: {
          type: "string",
          description: "授权公告日（YYYY-MM-DD）；决定授权当年所处专利年度与年费序号，缺失时年费期限返回 pending",
        },
        notices: {
          type: "array",
          description:
            "本案收到的、会启动期限的通知（受理通知书 acceptance-notice、一通 office-action-first、" +
            "后续审查意见 office-action-subsequent、驳回决定 rejection-decision、授权通知 grant-notice、" +
            "复审通知书 reexamination-notice）。缺哪类通知，该类期限就以 pending 呈现并指名该通知。",
          items: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "acceptance-notice",
                  "office-action-first",
                  "office-action-subsequent",
                  "rejection-decision",
                  "grant-notice",
                  "reexamination-notice",
                ],
              },
              mode: {
                type: "string",
                enum: ["electronic", "postal", "personal", "publication"],
                description: "送达方式；缺省为 electronic（电子送达不加15日）",
              },
              dispatchDate: { type: "string", description: "发文日（YYYY-MM-DD）" },
              enteredDate: { type: "string", description: "进入当事人电子系统的日期（有证据时，优先于发文日）" },
              actualReceiptDate: { type: "string", description: "邮寄时当事人举证的实际收到日" },
              handedOverDate: { type: "string", description: "直接送交的交付日" },
              publicationDate: { type: "string", description: "公告送达的公告日" },
              designatedMonths: { type: "number", description: "通知书自身指定的期限月数（覆盖通常长度）" },
            },
          },
        },
        restDayRule: {
          type: "string",
          enum: ["apply", "omit"],
          description: "是否应用细则第5条顺延：apply（默认）| omit（只报期限本体届满日，用于记录期限本身）",
        },
        today: { type: "string", description: "基准日（YYYY-MM-DD）；缺省取服务器当天，给出后报告可复现" },
      },
      required: ["kind", "filingDate", "claimsPriority"],
    },
    outputSchema: {
      type: "object",
      required: [
        "kind",
        "filingDate",
        "today",
        "claimsPriority",
        "restDayRule",
        "calendarCoveredYears",
        "computed",
        "pending",
        "report",
      ],
      additionalProperties: false,
      properties: {
        kind: { type: "string" },
        filingDate: { type: "string" },
        today: { type: "string" },
        claimsPriority: { type: "boolean" },
        priorityDate: { type: "string" },
        restDayRule: { type: "string" },
        calendarCoveredYears: { type: "array", items: { type: "number" } },
        computed: {
          type: "array",
          items: {
            type: "object",
            required: [
              "id",
              "label",
              "legalBasis",
              "rawDueDate",
              "rollForward",
              "daysRemaining",
              "daysRemainingBasis",
              "status",
              "rolledForward",
              "requiresFullCalendar",
            ],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              legalBasis: { type: "string" },
              rawDueDate: { type: "string" },
              dueDate: { type: "string" },
              dueDateLowerBound: { type: "string" },
              rollForward: { type: "string" },
              daysRemaining: { type: "number" },
              daysRemainingBasis: { type: "string" },
              status: { type: "string" },
              rolledForward: { type: "boolean" },
              requiresFullCalendar: { type: "boolean" },
              calendarCaveat: { type: "string" },
              triggerBasis: { type: "string" },
              triggerCaveat: { type: "string" },
              patentYear: { type: "number" },
              restorationExcluded: { type: "string" },
              latePaymentWindow: {
                type: "object",
                required: ["from", "to", "months", "monthlyRate", "legalBasis", "note"],
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                  months: { type: "number" },
                  monthlyRate: { type: "number" },
                  legalBasis: { type: "string" },
                  note: { type: "string" },
                },
              },
            },
          },
        },
        pending: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "label", "legalBasis", "requiredInput", "reason"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              legalBasis: { type: "string" },
              requiredInput: { type: "string" },
              reason: { type: "string" },
              requiresFullCalendar: { type: "boolean" },
            },
          },
        },
        report: { type: "string" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      try {
        loadWorkCalendar();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: "setup_required",
          reason: `${CALENDAR_ASSET_HINT}（${error instanceof Error ? error.message : String(error)}）`,
        };
      }
    },
    execute: async input => {
      let calendar;
      try {
        calendar = loadWorkCalendar();
      } catch (error) {
        return {
          content: [{ type: "text", text: `错误：${CALENDAR_ASSET_HINT}` }],
          metadata: {
            error: "work_calendar_unavailable",
            detail: error instanceof Error ? error.message : String(error),
          },
        };
      }

      let query: DeadlineQuery;
      try {
        query = toQuery(input);
      } catch (error) {
        if (error instanceof DeadlineQueryError) {
          return {
            content: [{ type: "text", text: `错误：${error.message}` }],
            metadata: { error: "invalid_query" },
          };
        }
        throw error;
      }

      let report: DeadlineReport;
      try {
        report = evaluateDeadlines(query, {
          calendar,
          reminderLeadDays: DEFAULT_REMINDER_LEAD_DAYS,
        });
      } catch (error) {
        if (
          error instanceof DeadlineQueryError ||
          error instanceof DeliveryInputError ||
          error instanceof CalendarDateError ||
          error instanceof WorkCalendarError
        ) {
          return {
            content: [{ type: "text", text: `错误：${error.message}` }],
            metadata: { error: "invalid_query" },
          };
        }
        throw error;
      }

      const output: PatentDeadlinesOutput = {
        kind: query.kind,
        filingDate: formatCalendarDate(query.filingDate),
        today: formatCalendarDate(query.today),
        claimsPriority: query.claimsPriority,
        ...(query.priorityDate !== undefined ? { priorityDate: formatCalendarDate(query.priorityDate) } : {}),
        restDayRule: report.restDayRule,
        calendarCoveredYears: report.calendarCoveredYears,
        computed: report.computed,
        pending: report.pending,
        report: renderDeadlineReport(report, {
          kind: query.kind,
          filingDate: formatCalendarDate(query.filingDate),
          today: formatCalendarDate(query.today),
          claimsPriority: query.claimsPriority,
          ...(query.priorityDate !== undefined ? { priorityDate: formatCalendarDate(query.priorityDate) } : {}),
        }),
      };
      return {
        content: [{ type: "text", text: output.report }],
        data: output,
        metadata: {
          domain: "patent",
          computed: report.computed.length,
          pending: report.pending.length,
          calendarCoveredYears: report.calendarCoveredYears,
        },
      };
    },
  };
}
