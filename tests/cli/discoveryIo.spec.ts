import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createCoreDiscoveryPlanIo } from "../../src/cli/discoveryIo.js";
import { resolveProjectStorageId } from "../../src/pilot/paths.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-dio-"));
}

function writeChatSession(pilotHome: string, projectRoot: string, sessionId: string, text: string): string {
  const projectId = resolveProjectStorageId(projectRoot, pilotHome);
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });
  const file = join(chatDir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "accepted_input",
        messages: [{ content: [{ type: "text", text }] }],
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("createCoreDiscoveryPlanIo", () => {
  it("extractProjectDirectory：绝对路径恒等", async () => {
    const dir = makeTempDir();
    try {
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      assert.equal(await io.extractProjectDirectory("/abs/proj"), resolve("/abs/proj"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extractProjectDirectory：非绝对路径回退到 pilotHome/projects", async () => {
    const dir = makeTempDir();
    try {
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      assert.equal(await io.extractProjectDirectory("demo"), join(dir, "projects", "demo"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getSessions：返回项目会话且 id 映射自 sessionId", async () => {
    const dir = makeTempDir();
    try {
      const projectRoot = join(dir, "workspace", "proj-a");
      mkdirSync(projectRoot, { recursive: true });
      writeChatSession(dir, projectRoot, "web-s1", "hello sati");
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      const result = await io.getSessions(projectRoot, 10, 0);
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0]!.id, "web-s1");
      assert.equal(result.sessions[0]!.sessionId, "web-s1");
      assert.match(String(result.sessions[0]!.summary), /hello sati/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getSessions：无会话目录返回空数组", async () => {
    const dir = makeTempDir();
    try {
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      const result = await io.getSessions(join(dir, "nope"), 10, 0);
      assert.deepEqual(result.sessions, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendRunEvent 写入 run-history.jsonl", async () => {
    const dir = makeTempDir();
    try {
      const projectRoot = "/abs/proj";
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      await io.appendRunEvent(projectRoot, {
        kind: "plan",
        runId: "run-1",
        sourceId: "p1",
        status: "completed",
        title: "Plan run",
      });
      const projectId = resolveProjectStorageId(projectRoot, dir);
      const historyPath = join(dir, "always-on", "projects", projectId, "run-history.jsonl");
      assert.ok(existsSync(historyPath));
      const line = readFileSync(historyPath, "utf8").trim();
      const parsed = JSON.parse(line) as { kind: string; runId: string };
      assert.equal(parsed.kind, "plan");
      assert.equal(parsed.runId, "run-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendRunLog / appendRunLogEvent 写入 runs 目录", async () => {
    const dir = makeTempDir();
    try {
      const projectRoot = "/abs/proj";
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      await io.appendRunLog(projectRoot, "run-1", ["line one", "line two"]);
      await io.appendRunLogEvent(projectRoot, "run-1", { phase: "execute" });
      const projectId = resolveProjectStorageId(projectRoot, dir);
      const runsDir = join(dir, "always-on", "projects", projectId, "runs");
      assert.ok(existsSync(join(runsDir, "run-1.log")));
      assert.ok(existsSync(join(runsDir, "run-1.events.jsonl")));
      assert.match(readFileSync(join(runsDir, "run-1.log"), "utf8"), /line one\nline two\n/);
      const eventLine = JSON.parse(readFileSync(join(runsDir, "run-1.events.jsonl"), "utf8")) as {
        phase: string;
        runId: string;
      };
      assert.equal(eventLine.phase, "execute");
      assert.equal(eventLine.runId, "run-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formatLogLine 输出规范行格式", () => {
    const dir = makeTempDir();
    try {
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      const line = io.formatLogLine({
        runId: "run-1",
        planId: "p1",
        phase: "discover",
        message: "  hello   world  ",
      });
      assert.match(line, /^\[AlwaysOnPlanRun\] ts=/);
      assert.match(line, /runId=run-1/);
      assert.match(line, /planId=p1/);
      assert.match(line, /phase=discover/);
      assert.match(line, /message="hello world"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isSessionActive 降级为 false", () => {
    const dir = makeTempDir();
    try {
      const io = createCoreDiscoveryPlanIo({ pilotHome: dir });
      assert.equal(io.isSessionActive("any"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
