import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BackgroundTaskRuntime, type BackgroundTaskCompletionEvent } from "../../src/task/runtime/BackgroundTaskRuntime.js";

describe("BackgroundTaskRuntime completion notifications", () => {
  it("emits one completion event with bounded output preview", async () => {
    const events: BackgroundTaskCompletionEvent[] = [];
    const runtime = new BackgroundTaskRuntime({
      onCompletion: (event) => events.push(event),
      completionPreviewBytes: 10,
    });

    const task = await runtime.start({
      command: `${process.execPath} -e "process.stdout.write('0123456789abcdef')"`,
      cwd: process.cwd(),
      sessionId: "session-1",
    });
    const completed = await runtime.waitFor(task.taskId);

    assert.equal(completed.status, "completed");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sessionId, "session-1");
    assert.equal(events[0]?.taskId, task.taskId);
    assert.equal(events[0]?.status, "completed");
    assert.equal(events[0]?.exitCode, 0);
    assert.equal(events[0]?.totalBytes, 16);
    assert.equal(events[0]?.outputPreview, "6789abcdef");
    assert.ok(events[0]?.startedAt);
    assert.ok(events[0]?.endedAt);
  });

  it("emits cancelled when a running task is stopped", async () => {
    const events: BackgroundTaskCompletionEvent[] = [];
    const runtime = new BackgroundTaskRuntime({ onCompletion: (event) => events.push(event) });

    const task = await runtime.start({
      command: `${process.execPath} -e "setTimeout(() => {}, 10000)"`,
      cwd: process.cwd(),
      sessionId: "session-2",
    });
    await runtime.stop(task.taskId, { graceMs: 1 });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, "cancelled");
    assert.equal(events[0]?.taskId, task.taskId);
  });

  it("waits for a task to finish without polling", async () => {
    const runtime = new BackgroundTaskRuntime();
    const task = await runtime.start({
      command: `${process.execPath} -e "setTimeout(() => { process.stdout.write('done') }, 25)"`,
      cwd: process.cwd(),
    });

    const waited = await runtime.wait(task.taskId, { timeoutMs: 1_000 });

    assert.ok(waited);
    assert.equal(waited.task.status, "completed");
    assert.equal(waited.task.exitCode, 0);
    assert.equal(waited.timedOut, false);
    assert.match(runtime.getOutput(task.taskId, 0).content, /done/u);
  });

  it("returns running on wait timeout without killing the task", async () => {
    const runtime = new BackgroundTaskRuntime();
    const task = await runtime.start({
      command: `${process.execPath} -e "setTimeout(() => { process.stdout.write('late') }, 80)"`,
      cwd: process.cwd(),
    });

    const early = await runtime.wait(task.taskId, { timeoutMs: 1 });
    assert.ok(early);
    assert.equal(early.task.status, "running");
    assert.equal(early.timedOut, true);

    const late = await runtime.wait(task.taskId, { timeoutMs: 1_000 });
    assert.ok(late);
    assert.equal(late.task.status, "completed");
    assert.equal(runtime.get(task.taskId)?.status, "completed");
  });

  it("reports aborted waits without stopping the task", async () => {
    const runtime = new BackgroundTaskRuntime();
    const task = await runtime.start({
      command: `${process.execPath} -e "setTimeout(() => { process.stdout.write('late') }, 80)"`,
      cwd: process.cwd(),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1).unref();

    const aborted = await runtime.wait(task.taskId, {
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    });

    assert.ok(aborted);
    assert.equal(aborted.outcome, "aborted");
    assert.equal(aborted.timedOut, true);
    assert.equal(runtime.get(task.taskId)?.status, "running");

    const late = await runtime.wait(task.taskId, { timeoutMs: 1_000 });
    assert.ok(late);
    assert.equal(late.task.status, "completed");
  });

  it("removes abort listeners after wait settles", async () => {
    const runtime = new BackgroundTaskRuntime();
    const task = await runtime.start({
      command: `${process.execPath} -e "process.stdout.write('done')"`,
      cwd: process.cwd(),
    });
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "abort") added += 1;
      return addEventListener(type, listener, options);
    }) as AbortSignal["addEventListener"];
    controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") removed += 1;
      return removeEventListener(type, listener, options);
    }) as AbortSignal["removeEventListener"];

    const waited = await runtime.wait(task.taskId, {
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    });

    assert.ok(waited);
    assert.equal(waited.outcome, "completed");
    assert.equal(added, 1);
    assert.equal(removed, 1);
  });
});
