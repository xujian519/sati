import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sati-bridge.js", () => ({
  getSatiGateway: vi.fn(async () => ({
    listProjects: async () => ({ projects: [] }),
  })),
}));

let tempHome;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sati-aon-events-"));
  process.env.SATI_HOME = tempHome;
});

afterEach(() => {
  delete process.env.SATI_HOME;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
  vi.resetModules();
});

/** 动态加载模块：vi.resetModules 保证每个用例拿到干净的模块级 TTL 缓存。 */
async function loadGetDashboardEvents() {
  vi.resetModules();
  const mod = await import("./always-on-events.js");
  return mod.getAlwaysOnDashboardEvents;
}

function writeProjectEvent(projectId, event) {
  const dir = join(tempHome, "always-on", "projects", projectId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
}

describe("getAlwaysOnDashboardEvents", () => {
  it("无事件目录返回空列表", async () => {
    const getEvents = await loadGetDashboardEvents();
    const { events } = await getEvents();
    expect(events).toEqual([]);
  });

  it("聚合各项目事件并按 timestamp 降序", async () => {
    const getEvents = await loadGetDashboardEvents();
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:01.000Z", type: "run_completed" });
    writeProjectEvent("p2", { projectKey: "/tmp/p2", timestamp: "2026-08-09T00:00:02.000Z", type: "run_started" });

    const { events } = await getEvents();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("run_started"); // 时间新者在前
    expect(events[1].type).toBe("run_completed");
    expect(events[0].projectName).toBeTruthy();
  });

  it("TTL 内重复调用命中缓存：文件新增事件不立即反映", async () => {
    const getEvents = await loadGetDashboardEvents();
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:01.000Z", type: "a" });

    const first = await getEvents();
    expect(first.events.length).toBe(1);

    // 5s TTL 内文件追加新事件：应命中缓存，仍返回旧结果
    writeProjectEvent("p1", {
      projectKey: "/tmp/p1",
      timestamp: "2026-08-09T00:00:02.000Z",
      type: "b",
      // 覆盖写：events.jsonl 只保留一条，验证缓存未重读文件
    });
    const second = await getEvents();
    expect(second.events.length).toBe(1);
    expect(second.events[0].type).toBe("a");
  });

  it("带 since 时绕过缓存，重新读取文件", async () => {
    const getEvents = await loadGetDashboardEvents();
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:01.000Z", type: "a" });

    await getEvents(); // 填充缓存
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:02.000Z", type: "b" });

    const { events } = await getEvents({ since: "2026-08-09T00:00:00.000Z" });
    expect(events.some(event => event.type === "b")).toBe(true);
  });

  it("不同 limit 不命中缓存（缓存按 limit 分键）", async () => {
    const getEvents = await loadGetDashboardEvents();
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:01.000Z", type: "a" });
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:02.000Z", type: "b" });

    const limited = await getEvents({ limit: 1 });
    expect(limited.events.length).toBe(1);
    expect(limited.events[0].type).toBe("b");

    // TTL 内换一个 limit：应重新读取，而非复用 1 条的结果
    const full = await getEvents({ limit: 5 });
    expect(full.events.length).toBe(2);
  });

  it("limit 生效", async () => {
    const getEvents = await loadGetDashboardEvents();
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:01.000Z", type: "a" });
    writeProjectEvent("p1", { projectKey: "/tmp/p1", timestamp: "2026-08-09T00:00:02.000Z", type: "b" });

    const { events } = await getEvents({ limit: 1 });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("b");
  });
});
