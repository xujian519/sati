import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  PLAN_STATUS_ORDER,
  sortDiscoveryPlans,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
  type WebPlanRecord,
  type WebPlanSession,
} from "../../../src/always-on/web/DiscoveryPlanStatus.js";

function makePlan(overrides: Partial<WebPlanRecord> = {}): WebPlanRecord {
  return {
    id: "p1",
    title: "Plan A",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T01:00:00.000Z",
    status: "ready",
    summary: "summary",
    rationale: "rationale",
    dedupeKey: "d1",
    sourceDiscoverySessionId: "sess-d",
    executionSessionId: "",
    executionStartedAt: "",
    executionLastActivityAt: "",
    executionStatus: "",
    latestSummary: "",
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: "/tmp/plans/p1.md",
    structureVersion: 1,
    ...overrides,
  };
}

const NO_SESSION: WebPlanSession = null;
const ACTIVE = (sessionId: string): boolean => sessionId === "exec-sess";

describe("computeExecutionStatus", () => {
  it("archived 状态恒为空串", () => {
    assert.equal(computeExecutionStatus(makePlan({ status: "archived" }), NO_SESSION, ACTIVE), "");
  });

  it("执行会话活跃 → running（优先于 executionStatus）", () => {
    const plan = makePlan({ executionSessionId: "exec-sess", executionStatus: "completed" });
    assert.equal(computeExecutionStatus(plan, NO_SESSION, ACTIVE), "running");
  });

  it("executionStatus=failed / completed 直接透传", () => {
    assert.equal(computeExecutionStatus(makePlan({ executionStatus: "failed" }), NO_SESSION, ACTIVE), "failed");
    assert.equal(computeExecutionStatus(makePlan({ executionStatus: "completed" }), NO_SESSION, ACTIVE), "completed");
  });

  it("executionStatus=queued：有执行会话与 session → completed，否则 queued", () => {
    const base = makePlan({ executionStatus: "queued" });
    assert.equal(computeExecutionStatus(base, NO_SESSION, ACTIVE), "queued");
    assert.equal(
      computeExecutionStatus(makePlan({ executionStatus: "queued", executionSessionId: "x" }), NO_SESSION, ACTIVE),
      "queued",
    );
    assert.equal(
      computeExecutionStatus(makePlan({ executionStatus: "queued", executionSessionId: "x" }), { id: "x" }, ACTIVE),
      "completed",
    );
  });

  it("executionStatus=running：有 session → completed，否则 running", () => {
    assert.equal(computeExecutionStatus(makePlan({ executionStatus: "running" }), NO_SESSION, ACTIVE), "running");
    assert.equal(
      computeExecutionStatus(makePlan({ executionStatus: "running", executionSessionId: "x" }), {}, ACTIVE),
      "completed",
    );
  });

  it("未知 executionStatus 但存在执行会话与 session → completed", () => {
    const plan = makePlan({ executionStatus: "something-else", executionSessionId: "x" });
    assert.equal(computeExecutionStatus(plan, { id: "x" }, ACTIVE), "completed");
    // 空对象 session 也是 truthy
    assert.equal(computeExecutionStatus(plan, {}, ACTIVE), "completed");
  });

  it("无 executionStatus / 会话信息时按 plan.status 透传（queued/running/completed/completed_no_report/failed）", () => {
    for (const status of ["queued", "running", "completed", "completed_no_report", "failed"]) {
      assert.equal(computeExecutionStatus(makePlan({ status }), NO_SESSION, ACTIVE), status, `status=${status}`);
    }
  });

  it("ready 且无任何执行信息 → 空串", () => {
    assert.equal(computeExecutionStatus(makePlan({ status: "ready" }), NO_SESSION, ACTIVE), "");
  });

  it("非活跃 sessionId 不触发 running（isSessionActive 按 id 精确匹配）", () => {
    const plan = makePlan({ executionSessionId: "other-sess", executionStatus: "running" });
    assert.equal(computeExecutionStatus(plan, NO_SESSION, ACTIVE), "running");
  });
});

describe("computePlanStatus", () => {
  it("archived → archived", () => {
    assert.equal(computePlanStatus(makePlan({ status: "archived" }), NO_SESSION, ACTIVE), "archived");
  });

  it("executionStatus 非空时优先返回 execution 状态", () => {
    assert.equal(
      computePlanStatus(makePlan({ status: "ready", executionStatus: "running" }), NO_SESSION, ACTIVE),
      "running",
    );
    assert.equal(
      computePlanStatus(makePlan({ status: "ready", executionStatus: "failed" }), NO_SESSION, ACTIVE),
      "failed",
    );
  });

  it("execution 状态为空 → 归一化 plan.status，缺省 ready", () => {
    assert.equal(computePlanStatus(makePlan({ status: "ready" }), NO_SESSION, ACTIVE), "ready");
    assert.equal(computePlanStatus(makePlan({ status: "completed" }), NO_SESSION, ACTIVE), "completed");
    // 空白 / 空字符串回落为 ready
    assert.equal(computePlanStatus(makePlan({ status: "   " }), NO_SESSION, ACTIVE), "ready");
    assert.equal(computePlanStatus(makePlan({ status: "" }), NO_SESSION, ACTIVE), "ready");
  });
});

describe("sortDiscoveryPlans", () => {
  function planWith(id: string, status: string, updatedAt?: string): WebPlanRecord {
    return makePlan({ id, status, updatedAt: updatedAt ?? "" });
  }

  it("按 PLAN_STATUS_ORDER 升序（running 最先）", () => {
    const plans = [
      planWith("c", "completed"),
      planWith("q", "queued"),
      planWith("r", "running"),
      planWith("rd", "ready"),
      planWith("a", "archived"),
    ];
    const sorted = sortDiscoveryPlans(plans);
    assert.deepEqual(
      sorted.map(p => p.id),
      ["r", "q", "rd", "c", "a"],
    );
  });

  it("同一状态按 updatedAt 降序", () => {
    const plans = [
      planWith("old", "ready", "2026-08-01T00:00:00.000Z"),
      planWith("new", "ready", "2026-08-03T00:00:00.000Z"),
      planWith("mid", "ready", "2026-08-02T00:00:00.000Z"),
    ];
    const sorted = sortDiscoveryPlans(plans);
    assert.deepEqual(
      sorted.map(p => p.id),
      ["new", "mid", "old"],
    );
  });

  it("未知状态排最后（order 99），缺失/非法 updatedAt 视为 0", () => {
    const plans = [
      planWith("unknown-no-date", "mystery"),
      planWith("unknown-bad-date", "mystery", "not-a-date"),
      planWith("ready", "ready", "2026-08-03T00:00:00.000Z"),
    ];
    const sorted = sortDiscoveryPlans(plans);
    assert.equal(sorted[0]!.id, "ready");
    assert.equal(sorted[1]!.id, "unknown-no-date");
    assert.equal(sorted[2]!.id, "unknown-bad-date");
  });

  it("不修改输入数组（返回新数组）", () => {
    const plans = [planWith("c", "completed"), planWith("r", "running")];
    const before = [...plans];
    const sorted = sortDiscoveryPlans(plans);
    assert.notEqual(sorted, plans);
    assert.deepEqual(plans, before);
  });

  it("PLAN_STATUS_ORDER 各状态顺序固定", () => {
    assert.equal(PLAN_STATUS_ORDER.running, 0);
    assert.equal(PLAN_STATUS_ORDER.queued, 2);
    assert.equal(PLAN_STATUS_ORDER.ready, 3);
    assert.equal(PLAN_STATUS_ORDER.failed, 4);
    assert.equal(PLAN_STATUS_ORDER.completed, 5);
    assert.equal(PLAN_STATUS_ORDER.completed_no_report, 5);
    assert.equal(PLAN_STATUS_ORDER.archived, 7);
  });
});

describe("toTimestampValue / toIsoTimestamp", () => {
  it("toTimestampValue：null/undefined → null；合法时间 → 毫秒数；非法 → null", () => {
    assert.equal(toTimestampValue(null), null);
    assert.equal(toTimestampValue(undefined), null);
    assert.equal(toTimestampValue("not-a-date"), null);
    assert.equal(toTimestampValue("2026-08-03T00:00:00.000Z"), Date.parse("2026-08-03T00:00:00.000Z"));
  });

  it("toIsoTimestamp：合法 → 规范化 ISO 字符串；非法 → 空串", () => {
    assert.equal(toIsoTimestamp("2026-08-03T00:00:00.000Z"), "2026-08-03T00:00:00.000Z");
    // 带时区的输入被规范化为 UTC
    assert.equal(toIsoTimestamp("2026-08-03T08:00:00+08:00"), "2026-08-03T00:00:00.000Z");
    assert.equal(toIsoTimestamp(null), "");
    assert.equal(toIsoTimestamp("garbage"), "");
  });
});

describe("pickLatestIsoTimestamp", () => {
  it("取所有合法值中的最大值", () => {
    assert.equal(
      pickLatestIsoTimestamp("2026-08-01T00:00:00.000Z", null, "2026-08-03T00:00:00.000Z", "bad"),
      "2026-08-03T00:00:00.000Z",
    );
  });

  it("全部非法 → 空串", () => {
    assert.equal(pickLatestIsoTimestamp(), "");
    assert.equal(pickLatestIsoTimestamp(null, undefined, "nope"), "");
  });
});

describe("normalizeString / truncateText / normalizeStringList", () => {
  it("normalizeString：非字符串或空白 → fallback，字符串 trim", () => {
    assert.equal(normalizeString(null), "");
    assert.equal(normalizeString(42), "");
    // 默认 fallback 为空串；空白字符串 trim 后为空 → 回落默认值
    assert.equal(normalizeString("   "), "");
    assert.equal(normalizeString("   ", "custom"), "custom");
    assert.equal(normalizeString("   hi  "), "hi");
  });

  it("truncateText：折叠空白，超长截断为 maxLength 并加省略号", () => {
    assert.equal(truncateText("hello   world"), "hello world");
    assert.equal(truncateText("a".repeat(300)), `${"a".repeat(217)}...`);
    assert.equal(truncateText("a".repeat(300), 10), "aaaaaaa...");
    assert.equal(truncateText("short"), "short");
    assert.equal(truncateText(null), "");
  });

  it("truncateText：恰好等于 maxLength 时不截断", () => {
    assert.equal(truncateText("abcdefghij", 10), "abcdefghij");
  });

  it("normalizeStringList：非数组 → []；过滤非字符串、trim、过滤空串", () => {
    assert.deepEqual(normalizeStringList(null), []);
    assert.deepEqual(normalizeStringList("not-array"), []);
    assert.deepEqual(normalizeStringList([" /a ", "", "b", 42, null, "  c  "]), ["/a", "b", "c"]);
  });
});
