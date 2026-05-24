import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskRuntime } from "../../src/task/index.js";

const hold = (s: number) => `node -e "setTimeout(()=>{},${s * 1000})"`;

test("C5.RT.1 start() spawns a real shell command and reports completed", async () => {
  const runtime = new BackgroundTaskRuntime();
  const task = await runtime.start({ command: `echo hello-bg && ${hold(0.05)}`, cwd: process.cwd() });
  assert.equal(task.status, "running");
  assert.ok(task.taskId);
  assert.ok(task.pid);
  await runtime.waitFor(task.taskId);
  const final = runtime.get(task.taskId)!;
  assert.equal(final.status, "completed");
  assert.equal(final.exitCode, 0);
  const slice = runtime.getOutput(task.taskId, 0);
  assert.match(slice.content, /hello-bg/);
});

test("C5.RT.2 stop() issues SIGTERM and flips status to cancelled", async () => {
  const runtime = new BackgroundTaskRuntime();
  const task = await runtime.start({ command: hold(5), cwd: process.cwd() });
  await runtime.stop(task.taskId, { graceMs: 200 });
  const final = runtime.get(task.taskId)!;
  assert.equal(final.status, "cancelled");
  assert.equal(final.interrupted, true);
});

test("C5.RT.3 stop() on already-finished task is a no-op", async () => {
  const runtime = new BackgroundTaskRuntime();
  const task = await runtime.start({ command: "echo done", cwd: process.cwd() });
  await runtime.waitFor(task.taskId);
  await runtime.stop(task.taskId);
  const final = runtime.get(task.taskId)!;
  assert.equal(final.status, "completed");
});

test("C5.RT.4 list() filters by agentId / status / kind", async () => {
  const runtime = new BackgroundTaskRuntime();
  const a = await runtime.start({ command: "echo a", cwd: process.cwd(), agentId: "agent-1" });
  const b = await runtime.start({ command: "echo b", cwd: process.cwd(), agentId: "agent-2", kind: "monitor" });
  await runtime.waitFor(a.taskId);
  await runtime.waitFor(b.taskId);
  const filtered = runtime.list({ agentId: "agent-1" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.taskId, a.taskId);
  const monitors = runtime.list({ kind: "monitor" });
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0]?.taskId, b.taskId);
});

test("C5.RT.5 killForAgent() stops only that agent's running tasks", async () => {
  const runtime = new BackgroundTaskRuntime();
  const a = await runtime.start({ command: hold(5), cwd: process.cwd(), agentId: "alpha" });
  const b = await runtime.start({ command: hold(5), cwd: process.cwd(), agentId: "beta" });
  await runtime.killForAgent("alpha");
  assert.equal(runtime.get(a.taskId)!.status, "cancelled");
  assert.equal(runtime.get(b.taskId)!.status, "running");
  await runtime.killAll();
});

test("C5.RT.6 killAll() stops every running task (SessionRouter onSessionEnd)", async () => {
  const runtime = new BackgroundTaskRuntime();
  const a = await runtime.start({ command: hold(5), cwd: process.cwd() });
  const b = await runtime.start({ command: hold(5), cwd: process.cwd() });
  await runtime.killAll();
  assert.equal(runtime.get(a.taskId)!.status, "cancelled");
  assert.equal(runtime.get(b.taskId)!.status, "cancelled");
});

test("C5.RT.7 maxTasks throws when exceeded", async () => {
  const runtime = new BackgroundTaskRuntime({ maxTasks: 1 });
  await runtime.start({ command: "echo first", cwd: process.cwd() });
  await assert.rejects(
    runtime.start({ command: "echo second", cwd: process.cwd() }),
    /max tasks/,
  );
});

test("C5.RT.8 getOutput supports incremental polling", async () => {
  const runtime = new BackgroundTaskRuntime();
  const task = await runtime.start({
    command: "echo line1 && echo line2 && echo line3",
    cwd: process.cwd(),
  });
  await runtime.waitFor(task.taskId);
  const a = runtime.getOutput(task.taskId, 0);
  assert.match(a.content, /line1/);
  assert.match(a.content, /line2/);
  assert.match(a.content, /line3/);
  const b = runtime.getOutput(task.taskId, a.nextOffset);
  assert.equal(b.content, "");
  assert.equal(b.nextOffset, a.nextOffset);
});
