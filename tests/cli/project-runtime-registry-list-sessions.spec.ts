import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectRuntimeRegistry } from "../../src/cli/ProjectRuntimeRegistry.js";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import type { TelemetryClient } from "../../src/telemetry/index.js";

/**
 * listSessions 轻量路径的行为锚（2026-10 桌面端启动风暴修复）。
 *
 * 历史行为：`listSessions` 先 `resolve(projectKey)` 全量构建项目运行时
 * （loadPilotConfig / ModelRuntime / PluginRuntime 技能扫描 / 知识解析器 /
 * 内置工具注册表）再读会话目录。桌面首屏的 GET /api/projects 会对全部
 * 工作区逐个调用该方法 ⇒「N 个项目 = N 次装配」（实测 23 次构建 ≈2.2s，
 * 占首屏墙钟一半）。
 *
 * 行为契约：
 *   1. 正确列出磁盘会话（与 listProjectSessions 同源）；
 *   2. 全程不触发 resolve —— `onProjectActivated` 在 resolve() 首行被调用
 *      （projectRuntimeFactory.ts：缓存检查与构建之前），计数为 0 即证明
 *      轻量路径成立。若将来有人把 resolve 加回来「顺带预热」，这里会最先红。
 */

function acceptedInputLine(sessionId: string, text: string, sequence = 1): string {
  return `${JSON.stringify({
    type: "accepted_input",
    sessionId,
    turnId: `t${sequence}`,
    sequence,
    createdAt: "2026-08-09T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  })}\n`;
}

function makeRegistry(pilotHome: string, projectRoot: string, onActivated: () => void): ProjectRuntimeRegistry {
  return new ProjectRuntimeRegistry({
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: {},
    permissionMode: "default",
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    telemetry: {} as unknown as TelemetryClient,
    onProjectActivated: onActivated,
  });
}

test("listSessions：列出磁盘会话且不触发运行时构建（onProjectActivated 零次）", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-registry-list-"));
  const projectRoot = join(pilotHome, "workspace");
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "第一条消息"));

    let activated = 0;
    const registry = makeRegistry(pilotHome, projectRoot, () => {
      activated += 1;
    });

    const result = await registry.listSessions({ projectKey: projectRoot });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.sessionId, "s1");
    assert.equal(result.sessions[0]?.summary, "第一条消息");
    assert.equal(activated, 0, "listSessions 不得触发 resolve（onProjectActivated 在 resolve 首行）");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("listSessions：limit/cursor 分页语义（轻量路径下同样成立，且全程零构建）", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-registry-list-page-"));
  const projectRoot = join(pilotHome, "workspace");
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "第一条消息"));
    writeFileSync(join(chatDir, "s2.jsonl"), acceptedInputLine("s2", "第二条消息"));

    let activated = 0;
    const registry = makeRegistry(pilotHome, projectRoot, () => {
      activated += 1;
    });

    const page1 = await registry.listSessions({ projectKey: projectRoot, limit: 1 });
    assert.equal(page1.sessions.length, 1);
    assert.equal(page1.nextCursor, "1", "恰好取满 limit 时必须给续页游标");
    const page2 = await registry.listSessions({ projectKey: projectRoot, limit: 1, cursor: page1.nextCursor });
    assert.equal(page2.sessions.length, 1);
    assert.equal(page2.nextCursor, "2");
    assert.notEqual(page2.sessions[0]?.sessionId, page1.sessions[0]?.sessionId, "两页不得重复");
    const page3 = await registry.listSessions({ projectKey: projectRoot, limit: 1, cursor: page2.nextCursor });
    assert.equal(page3.sessions.length, 0);
    assert.equal(page3.nextCursor, undefined, "取不满 limit 即到末页（无游标）");
    assert.equal(activated, 0, "分页同走轻量路径");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
