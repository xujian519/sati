import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiscoveryPlanService } from "../../src/always-on/web/DiscoveryPlanService.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { SATI_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import type {
  AlwaysOnApplyCycleInput,
  AlwaysOnApplyCycleResult,
  AlwaysOnListPlansResult,
  AlwaysOnReadReportResult,
  AlwaysOnRerunPlanResult,
} from "../../src/gateway/protocol/types.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

function makeStubService(): { service: DiscoveryPlanService; calls: { queue: number; updates: string[] } } {
  const calls = { queue: 0, updates: [] as string[] };
  const service = {
    getPlansOverview: async () => ({
      plans: [{ id: "p1", title: "Plan A", status: "ready", createdAt: "2026-08-01T00:00:00Z" }],
    }),
    readReport: async () => ({ content: "# Report" }),
    getCyclesOverview: async () => ({ cycles: [] }),
    archiveCycle: async () => ({ archived: true }),
    queueCycleApply: async (_projectKey: string, cycleId: string) => {
      calls.queue += 1;
      return {
        cycle: {
          id: cycleId,
          projectKey: "proj",
          status: "applying",
          workspace: { strategy: "worktree", cwd: "/tmp/wt" },
          planIds: ["p1"],
          createdAt: "2026-08-01T00:00:00Z",
        },
        projectRoot: "/fake/root",
        executionToken: "tok-1",
      };
    },
    updateCycleExecution: async (_projectKey: string, cycleId: string, updates: { status: string }) => {
      calls.updates.push(updates.status);
      return {
        cycle: {
          id: cycleId,
          projectKey: "proj",
          status: updates.status === "completed" ? "applied" : "active",
          workspace: { strategy: "worktree", cwd: "/tmp/wt" },
          planIds: ["p1"],
          createdAt: "2026-08-01T00:00:00Z",
        },
      };
    },
    applyCycle: async (
      _projectKey: string,
      cycleId: string,
      apply:
        | ((input: { projectKey: string; workCycleId: string; projectName: string }) => Promise<{
            sessionKey: string;
            error?: { code: string; message: string };
          }>)
        | undefined,
    ) => {
      if (!apply) {
        return { cycle: null, error: { code: "not_configured", message: "Always-On apply is not configured." } };
      }
      calls.queue += 1;
      const applyResult = await apply({ projectKey: "/fake/root", workCycleId: cycleId, projectName: "demo" });
      if (applyResult.error) {
        calls.updates.push("failed");
        return { cycle: null, error: applyResult.error };
      }
      calls.updates.push("completed");
      return { cycle: null, sessionKey: applyResult.sessionKey };
    },
  };
  return { service: service as unknown as DiscoveryPlanService, calls };
}

function makeGateway(service: DiscoveryPlanService | undefined, extra: Record<string, unknown> = {}): InProcessGateway {
  return new InProcessGateway({} as SessionRouter, { discoveryPlanService: service, ...extra });
}

describe("gateway 协议版本", () => {
  it("discovery 协议方法扩展后版本为 1.1（审批方法扩展后为 1.2，cron 更新为 1.3，panel_heartbeat 为 1.4，steer_turn 为 1.6）", () => {
    // 1.1 = discovery-plan 可选方法；1.2 = 输出门禁 HITL 审批可选方法；1.3 = cron_update 可选方法；
    // 1.4 = team-activity-panel 可选方法（panel_heartbeat / team_panel_snapshot / team_tool_call）；
    // 1.6 = mid-turn steering 可选方法（steer_turn / cancel_steer + steer_applied / steer_unapplied）。
    assert.ok(["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"].includes(SATI_GATEWAY_PROTOCOL_VERSION));
  });
});

describe("InProcessGateway 新增 discovery 方法", () => {
  it("alwaysOnListPlans 转发到 DiscoveryPlanService.getPlansOverview", async () => {
    const { service } = makeStubService();
    const gateway = makeGateway(service);
    const result: AlwaysOnListPlansResult = await gateway.alwaysOnListPlans({ projectKey: "/proj" });
    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0]!.id, "p1");
  });

  it("alwaysOnReadReport 转发到 readReport", async () => {
    const { service } = makeStubService();
    const gateway = makeGateway(service);
    const result: AlwaysOnReadReportResult = await gateway.alwaysOnReadReport({ projectKey: "/proj", planId: "p1" });
    assert.equal(result.content, "# Report");
  });

  it("未注入 service 时返回 not_configured 结果而非抛错", async () => {
    const gateway = makeGateway(undefined);
    const listResult = await gateway.alwaysOnListPlans({ projectKey: "/proj" });
    assert.equal(listResult.error?.code, "not_configured");
    assert.deepEqual(listResult.plans, []);

    const applyResult = await gateway.alwaysOnApplyCycle({ projectKey: "/proj", workCycleId: "cyc-1" });
    assert.equal(applyResult.error?.code, "not_configured");
    assert.equal(applyResult.cycle, null);
  });

  it("panelHeartbeat 未接线时返回 not_configured 结果而非抛错（S3 评审兜底形态）", async () => {
    const gateway = makeGateway(undefined);
    const result = await gateway.panelHeartbeat({ sessionKeys: ["s1"] });
    assert.equal(result.touched, 0);
    assert.equal(result.error?.code, "not_configured");
  });

  it("alwaysOnApplyCycle 委托 service.applyCycle（queue → apply → finalize 在 service 内）", async () => {
    const { service, calls } = makeStubService();
    const gateway = makeGateway(service, {
      alwaysOnApply: async () => ({ sessionKey: "s9" }),
    });
    const result: AlwaysOnApplyCycleResult = await gateway.alwaysOnApplyCycle({
      projectKey: "/proj",
      workCycleId: "cyc-1",
    });
    assert.equal(calls.queue, 1);
    assert.deepEqual(calls.updates, ["completed"]);
    assert.equal(result.sessionKey, "s9");
    assert.equal(result.error, undefined);
  });

  it("alwaysOnApplyCycle 失败路径：apply 报错 → service 回滚为 failed", async () => {
    const { service, calls } = makeStubService();
    const gateway = makeGateway(service, {
      alwaysOnApply: async () => ({ sessionKey: "", error: { code: "apply_error", message: "boom" } }),
    });
    const result: AlwaysOnApplyCycleResult = await gateway.alwaysOnApplyCycle({
      projectKey: "/proj",
      workCycleId: "cyc-1",
    });
    assert.deepEqual(calls.updates, ["failed"]);
    assert.equal(result.error?.code, "apply_error");
  });

  it("alwaysOnApplyCycle 未配置 apply handler 时 service 返回 not_configured 且不排队", async () => {
    const { service, calls } = makeStubService();
    const gateway = makeGateway(service);
    const result: AlwaysOnApplyCycleResult = await gateway.alwaysOnApplyCycle({
      projectKey: "/proj",
      workCycleId: "cyc-1",
    });
    assert.equal(result.error?.code, "not_configured");
    assert.equal(calls.queue, 0);
  });
});

describe("RemoteGateway 请求封装", () => {
  function makeRemote(record: { method: string; params: unknown }): RemoteGateway {
    const client = {
      request: async (method: string, params: unknown) => {
        record.method = method;
        record.params = params;
        return {};
      },
    } as unknown as GatewayWsClient;
    return new RemoteGateway(client);
  }

  it("alwaysOnListPlans 走 always_on_list_plans 方法", async () => {
    const record = { method: "", params: undefined };
    const remote = makeRemote(record);
    await remote.alwaysOnListPlans({ projectKey: "/proj" });
    assert.equal(record.method, "always_on_list_plans");
    assert.deepEqual(record.params, { projectKey: "/proj" });
  });

  it("alwaysOnApplyCycle 走 always_on_apply_cycle 方法", async () => {
    const record = { method: "", params: undefined };
    const remote = makeRemote(record);
    const input: AlwaysOnApplyCycleInput = { projectKey: "/proj", workCycleId: "cyc-1" };
    await remote.alwaysOnApplyCycle(input);
    assert.equal(record.method, "always_on_apply_cycle");
    assert.deepEqual(record.params, input);
  });

  it("alwaysOnRerunPlan 维持既有方法名", async () => {
    const record = { method: "", params: undefined };
    const remote = makeRemote(record);
    const result = (await remote.alwaysOnRerunPlan({
      projectKey: "/p",
      planId: "p1",
      projectName: "demo",
    })) as AlwaysOnRerunPlanResult;
    assert.equal(record.method, "always_on_rerun_plan");
    assert.equal(result.runId, undefined);
  });
});
