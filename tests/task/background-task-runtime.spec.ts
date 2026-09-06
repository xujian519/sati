import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { BackgroundTaskRuntime } from "../../src/task/index.js";
import type {
  BackgroundTaskCompletionEvent,
  BackgroundTaskRuntimeOptions,
  StartTaskSpec,
} from "../../src/task/runtime/BackgroundTaskRuntime.js";

type FakeChild = EventEmitter & {
  pid: number;
  unref(): void;
  kill(signal: string): boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killedSignals: string[];
};

function makeFakeChild(pid = 1234): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killedSignals = [];
  child.unref = () => {};
  child.kill = signal => {
    child.killedSignals.push(signal);
    return true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeRuntime(overrides: Partial<BackgroundTaskRuntimeOptions> = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args?: string[]; options: Record<string, unknown> }> = [];
  const spawnFn = ((
    command: string,
    argsOrOptions: string[] | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ) => {
    const usesExplicitArgs = Array.isArray(argsOrOptions);
    spawnCalls.push({
      command,
      args: usesExplicitArgs ? argsOrOptions : undefined,
      options: (usesExplicitArgs ? maybeOptions : argsOrOptions) as Record<string, unknown>,
    });
    const child = makeFakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  const now = () => new Date("2026-01-01T00:00:00Z");
  const runtime = new BackgroundTaskRuntime({
    spawn: spawnFn,
    now,
    maxTasks: 3,
    completionPreviewBytes: 100,
    ...overrides,
  });
  return { runtime, children, spawnCalls };
}

function startSpec(overrides: Partial<StartTaskSpec> = {}): StartTaskSpec {
  return {
    command: "echo hello",
    cwd: "/tmp",
    ...overrides,
  };
}

test("start spawns detached shell command and marks task running", async () => {
  const { runtime, children, spawnCalls } = makeRuntime();
  const task = await runtime.start(startSpec({ command: "ls -la", agentId: "a1", sessionId: "s1" }));
  assert.equal(task.status, "running");
  assert.equal(task.type, "local_bash");
  assert.equal(task.kind, "bash");
  assert.equal(task.agentId, "a1");
  assert.equal(task.sessionId, "s1");
  assert.equal(task.command, "ls -la");
  assert.equal(task.cwd, "/tmp");
  assert.equal(task.isBackgrounded, true);
  assert.equal(spawnCalls.length, 1);
  // 显式 shell 形式：spawn(<shell>, ["-c", command], options)（bash 优先解析）。
  assert.notEqual(spawnCalls[0]!.command, "ls -la");
  assert.deepEqual(spawnCalls[0]!.args, ["-c", "ls -la"]);
  assert.equal(spawnCalls[0]!.options.shell, undefined);
  assert.equal(spawnCalls[0]!.options.detached, true);
  assert.equal(children[0]!.pid, task.pid);
});

test("exit code 0 marks task completed and fires onCompletion", async () => {
  const completions: BackgroundTaskCompletionEvent[] = [];
  const { runtime, children } = makeRuntime({ onCompletion: e => completions.push(e) });
  const task = await runtime.start(startSpec());
  children[0]!.stdout.emit("data", "hello output\n");
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(task.taskId);

  assert.equal(task.status, "completed");
  assert.equal(task.exitCode, 0);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.status, "completed");
  assert.equal(completions[0]!.outputPreview, "hello output\n");
  assert.equal(completions[0]!.totalBytes, 13);
  assert.equal(completions[0]!.taskId, task.taskId);
  assert.equal(task.endedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("non-zero exit code marks task failed", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", 2, null);
  await runtime.waitFor(task.taskId);
  assert.equal(task.status, "failed");
  assert.equal(task.exitCode, 2);
});

test("exit with SIGTERM signal marks task cancelled", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", null, "SIGTERM");
  await runtime.waitFor(task.taskId);
  assert.equal(task.status, "cancelled");
});

test("spawn throwing marks task failed with spawn error output", async () => {
  const spawnFn = (() => {
    throw new Error("command not found");
  }) as unknown as typeof import("node:child_process").spawn;
  const runtime = new BackgroundTaskRuntime({ spawn: spawnFn, now: () => new Date("2026-01-01T00:00:00Z") });
  const task = await runtime.start(startSpec());
  assert.equal(task.status, "failed");
  assert.equal(task.completionStatusSentInAttachment, true);
  assert.ok(task.endedAt);
  const output = runtime.getOutput(task.taskId, 0);
  assert.match(output.content, /spawn error: command not found/);
});

test("maxTasks limit throws on overflow", async () => {
  const { runtime, children } = makeRuntime();
  await runtime.start(startSpec());
  await runtime.start(startSpec());
  await runtime.start(startSpec());
  await assert.rejects(() => runtime.start(startSpec()), /max concurrent tasks \(3\) exceeded/);
  // Cleanup: let children exit so nothing dangles.
  for (const child of children) {
    child.emit("exit", 0, null);
  }
});

test("list filters by agentId, kind and status", async () => {
  const { runtime, children } = makeRuntime();
  await runtime.start(startSpec({ agentId: "a1", kind: "bash" }));
  await runtime.start(startSpec({ agentId: "a2", kind: "monitor" }));
  const a1 = await runtime.start(startSpec({ agentId: "a1", kind: "monitor" }));

  assert.equal(runtime.list({ agentId: "a1" }).length, 2);
  assert.equal(runtime.list({ kind: "monitor" }).length, 2);
  assert.equal(runtime.list({ status: "running" }).length, 3);
  assert.equal(runtime.list({ status: ["running", "completed"] }).length, 3);
  assert.equal(runtime.list({ agentId: "a1", kind: "monitor" }).length, 1);

  children[2]!.emit("exit", 0, null);
  await runtime.waitFor(a1.taskId);
  assert.equal(runtime.list({ status: "completed" }).length, 1);
  assert.equal(runtime.list({ status: "running" }).length, 2);
  for (const child of children.slice(0, 2)) {
    child.emit("exit", 0, null);
  }
});

test("get returns task and getOutput reads stdout/stderr", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec());
  assert.equal(runtime.get(task.taskId)?.taskId, task.taskId);
  assert.equal(runtime.get("missing"), undefined);

  children[0]!.stdout.emit("data", "out1\n");
  children[0]!.stderr.emit("data", "err1\n");
  const slice = runtime.getOutput(task.taskId, 0);
  assert.equal(slice.content, "out1\nerr1\n");
  assert.equal(slice.totalBytes, 10);
  assert.throws(() => runtime.getOutput("missing", 0), /Unknown taskId/);
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(task.taskId);
});

test("stop sends SIGTERM and cancels on quick exit", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec({ command: "sleep 100" }));
  const stopPromise = runtime.stop(task.taskId, { graceMs: 1000 });
  children[0]!.emit("exit", 143, "SIGTERM");
  await stopPromise;

  assert.deepEqual(children[0]!.killedSignals, ["SIGTERM"]);
  assert.equal(task.interrupted, true);
  assert.equal(task.status, "cancelled");
  assert.equal(task.exitCode, 143);
});

test("stop escalates to SIGKILL when child does not exit within grace", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec({ command: "sleep 100" }));
  const stopPromise = runtime.stop(task.taskId, { graceMs: 10 });
  // Let the grace timer fire SIGKILL, then let the child exit.
  await new Promise(resolve => setTimeout(resolve, 50));
  children[0]!.emit("exit", 137, "SIGKILL");
  await stopPromise;

  assert.deepEqual(children[0]!.killedSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(task.status, "cancelled");
});

test("stop on unknown taskId throws; stop on finished task is a no-op", async () => {
  const { runtime, children } = makeRuntime();
  await assert.rejects(() => runtime.stop("nope"), /Unknown taskId/);
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(task.taskId);
  await runtime.stop(task.taskId); // no throw
  assert.equal(task.status, "completed");
});

test("killAll and killForAgent stop running tasks only", async () => {
  const { runtime, children } = makeRuntime();
  await runtime.start(startSpec({ agentId: "a1" }));
  await runtime.start(startSpec({ agentId: "a2" }));
  const done = await runtime.start(startSpec({ agentId: "a2" }));
  children[2]!.emit("exit", 0, null);
  await runtime.waitFor(done.taskId);

  const killA2 = runtime.killForAgent("a2");
  await new Promise(resolve => setImmediate(resolve));
  children[1]!.emit("exit", null, "SIGTERM");
  await killA2;
  assert.equal(children[1]!.killedSignals.length, 1);

  const killAll = runtime.killAll();
  await new Promise(resolve => setImmediate(resolve));
  children[0]!.emit("exit", null, "SIGTERM");
  await killAll;
  assert.equal(children[0]!.killedSignals.length, 1);
  // Completed task untouched.
  assert.equal(children[2]!.killedSignals.length, 0);
});

test("wait resolves on completion, timeout and abort", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec());

  const completed = runtime.wait(task.taskId, { timeoutMs: 1000 });
  children[0]!.emit("exit", 0, null);
  const completedResult = await completed;
  assert.equal(completedResult?.outcome, "completed");
  assert.equal(completedResult?.timedOut, false);

  const task2 = await runtime.start(startSpec());
  // wait()'s internal timeout timer is unref'd; keep the event loop alive
  // so it can fire while we await the timeout outcome.
  const keepAlive = setInterval(() => {}, 1000);
  let timedOut: Awaited<ReturnType<typeof runtime.wait>>;
  try {
    timedOut = await runtime.wait(task2.taskId, { timeoutMs: 20 });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(timedOut?.outcome, "timeout");
  assert.equal(timedOut?.timedOut, true);
  children[1]!.emit("exit", 0, null);

  const controller = new AbortController();
  const task3 = await runtime.start(startSpec());
  const aborted = runtime.wait(task3.taskId, { abortSignal: controller.signal });
  controller.abort();
  const abortedResult = await aborted;
  assert.equal(abortedResult?.outcome, "aborted");
  children[2]!.emit("exit", 0, null);

  assert.equal(await runtime.wait("missing"), undefined);
});

test("waitFor convenience resolves to final task", async () => {
  const { runtime, children } = makeRuntime();
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", 0, null);
  const awaited = await runtime.waitFor(task.taskId);
  assert.equal(awaited.status, "completed");
});

test("terminal entries do not count toward the concurrent maxTasks cap", async () => {
  const { runtime, children } = makeRuntime({ maxTasks: 1 });
  const first = await runtime.start(startSpec());
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(first.taskId);
  assert.equal(runtime.get(first.taskId)?.status, "completed");

  // 已结束任务不占名额：第二个任务可正常启动（修复前会永久抛 max tasks exceeded）。
  const second = await runtime.start(startSpec());
  assert.equal(second.status, "running");
});

test("running tasks still count toward maxTasks", async () => {
  const { runtime } = makeRuntime({ maxTasks: 1 });
  await runtime.start(startSpec());
  await assert.rejects(() => runtime.start(startSpec()), /max concurrent tasks/);
});

test("finished tasks are swept after finishedTaskTtlMs", async () => {
  let current = new Date("2026-01-01T00:00:00Z");
  const { runtime, children } = makeRuntime({
    finishedTaskTtlMs: 1_000,
    now: () => current,
  });
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(task.taskId);

  // TTL 内保留可查询。
  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.get(task.taskId)?.status, "completed");

  // 时钟越过 TTL 后 list() 触发清扫，entry（含输出缓冲）被释放。
  current = new Date("2026-01-01T00:01:01Z");
  assert.equal(runtime.list().length, 0);
  assert.equal(runtime.get(task.taskId), undefined);
});

test("finishedTaskTtlMs=0 disables sweeping", async () => {
  let current = new Date("2026-01-01T00:00:00Z");
  const { runtime, children } = makeRuntime({
    finishedTaskTtlMs: 0,
    now: () => current,
  });
  const task = await runtime.start(startSpec());
  children[0]!.emit("exit", 0, null);
  await runtime.waitFor(task.taskId);

  current = new Date("2027-01-01T00:00:00Z");
  assert.equal(runtime.list().length, 1);
});
