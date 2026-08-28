import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import { parseCronConfig } from "../../../src/cron/config/parseCronConfig.js";

function parse(raw: unknown): { config: ReturnType<typeof parseCronConfig>; diagnostics: PilotConfigDiagnostic[] } {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseCronConfig(raw, diagnostics);
  return { config, diagnostics };
}

function offPeakWarnings(diagnostics: PilotConfigDiagnostic[]): PilotConfigDiagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.code === "CRON_OFFPEAK_INVALID");
}

describe("parseCronConfig.offPeakHours", () => {
  it("未配置 → undefined，无诊断", () => {
    const { config, diagnostics } = parse({});
    assert.equal(config?.offPeakHours, undefined);
    assert.deepEqual(offPeakWarnings(diagnostics), []);
  });

  it("合法 [2,6] → 解析成功，无诊断", () => {
    const { config, diagnostics } = parse({ offPeakHours: [2, 6] });
    assert.deepEqual(config?.offPeakHours, { startHour: 2, endHour: 6 });
    assert.deepEqual(offPeakWarnings(diagnostics), []);
  });

  it("合法 [23,24]（尾段窗口）→ 解析成功", () => {
    const { config } = parse({ offPeakHours: [23, 24] });
    assert.deepEqual(config?.offPeakHours, { startHour: 23, endHour: 24 });
  });

  it("长度非 2 → 禁用并告警", () => {
    const { config, diagnostics } = parse({ offPeakHours: [2, 6, 8] });
    assert.equal(config?.offPeakHours, undefined);
    assert.equal(offPeakWarnings(diagnostics).length, 1);
  });

  it("非数组 → 禁用并告警", () => {
    const { config, diagnostics } = parse({ offPeakHours: "2-6" });
    assert.equal(config?.offPeakHours, undefined);
    assert.equal(offPeakWarnings(diagnostics).length, 1);
  });

  it("start >= end → 禁用并告警（跨日窗口不支持）", () => {
    for (const offPeakHours of [
      [6, 2],
      [5, 5],
    ]) {
      const { config, diagnostics } = parse({ offPeakHours });
      assert.equal(config?.offPeakHours, undefined);
      assert.equal(offPeakWarnings(diagnostics).length, 1);
    }
  });

  it("越界或非整数 → 禁用并告警", () => {
    for (const offPeakHours of [
      [-1, 5],
      [2, 25],
      [1.5, 3],
      [2, "6"],
    ]) {
      const { config, diagnostics } = parse({ offPeakHours });
      assert.equal(config?.offPeakHours, undefined);
      assert.equal(offPeakWarnings(diagnostics).length, 1);
    }
  });

  it("其他字段解析不受 offPeakHours 影响（默认值保留）", () => {
    const { config } = parse({ offPeakHours: [2, 6], timezone: "Asia/Shanghai", maxConcurrentRuns: 3 });
    assert.deepEqual(config?.offPeakHours, { startHour: 2, endHour: 6 });
    assert.equal(config?.timezone, "Asia/Shanghai");
    assert.equal(config?.maxConcurrentRuns, 3);
  });
});
