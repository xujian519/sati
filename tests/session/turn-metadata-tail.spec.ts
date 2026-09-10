import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { AgentSession } from "../../src/agent/session/AgentSession.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function result(sessionId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId: "turn-1",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T10:00:00.000Z",
    completedAt: "2026-09-10T10:00:01.000Z",
  };
}

test("pending title generation does not hold subsequent turns and cannot overwrite a manual title", async () => {
  for (const manuallyRenamed of [false, true]) {
    const sessionId = `background-title-${manuallyRenamed}`;
    const transcript = new InMemoryTranscriptWriter();
    const metadataStore = new SessionMetadataStore({ transcript, sessionId });
    let resolveTitle!: (title: string) => void;
    const title = new Promise<string>(resolve => {
      resolveTitle = resolve;
    });
    let titleCalls = 0;
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const completed = { ...result(sessionId), turnId: input.turnId };
        yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
        return { result: completed, messages: input.messages };
      },
    } as AgentLoop;
    const runner = new TurnRunner(
      loop,
      transcript,
      undefined,
      () => new Date(),
      undefined,
      { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
      {
        metadataStore,
        autoGenerateSessionTitle: true,
        sessionTitleGenerator: async () => {
          titleCalls++;
          return title;
        },
      },
    );
    const session = new AgentSession({ sessionId, turnRunner: runner });
    const drain = async (text: string) => {
      for await (const _ of session.submit({ type: "text", text })) {
        /* drain */
      }
    };
    // The old implementation cannot finish either turn until resolveTitle is called.
    try {
      await Promise.race([
        (async () => {
          await drain("First");
          await drain("Second");
        })(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("title blocked turn completion")), 1000);
          timer.unref();
        }),
      ]);
      assert.equal(session.snapshot().status, "idle");
      assert.equal(titleCalls, 1);
      assert.equal(metadataStore.getSnapshot().lastPrompt, "Second");
      if (manuallyRenamed) await metadataStore.saveTitle("My title");
    } finally {
      resolveTitle("Generated title");
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(metadataStore.getSnapshot().lastPrompt, "Second");
    assert.equal(metadataStore.getSnapshot().aiTitle, manuallyRenamed ? undefined : "Generated title");
    assert.equal(metadataStore.getSnapshot().title, manuallyRenamed ? "My title" : undefined);
    assert.equal(transcript.entries.filter(entry => entry.type === "accepted_input").length, 2);
  }
});

test("title request failure does not fail a completed conversation", async () => {
  const sessionId = "failed-background-title";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId });
  let rejectTitle!: (error: Error) => void;
  const title = new Promise<string>((_, reject) => {
    rejectTitle = reject;
  });
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const completed = result(sessionId);
      yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
      return { result: completed, messages: input.messages };
    },
  } as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: async () => title },
  );
  const session = new AgentSession({ sessionId, turnRunner: runner });
  for await (const _ of session.submit({ type: "text", text: "Hello" })) {
    /* drain */
  }
  rejectTitle(new Error("title request timed out"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().status, "idle");
  assert.equal(metadataStore.getSnapshot().aiTitle, undefined);
});

for (const replace of [false, true]) {
  test(`closing a session prevents its late title from ${replace ? "changing a replacement transcript" : "recreating a deleted transcript"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sati-title-lifecycle-"));
    const path = join(directory, "session.jsonl");
    const sessionId = "web:late-title";
    // M3 写缓冲：TurnRunner 会 await 输入落盘的 ack，而落盘只由 turn_result
    // 或 unref 的兜底定时器触发——测试环境的事件循环可能在定时器前清空。
    // 关掉缓冲（既有测试约定）使 ack 即时结算，与上游无缓冲语义等价。
    const transcript = new JsonlTranscriptWriter({ path, flushThresholdBytes: 0 });
    const metadataStore = new SessionMetadataStore({ transcript, sessionId });
    let resolveTitle!: (title: string) => void;
    let signal: AbortSignal | undefined;
    const title = new Promise<string>(resolve => {
      resolveTitle = resolve;
    });
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const completed = result(sessionId);
        yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
        return { result: completed, messages: input.messages };
      },
    } as AgentLoop;
    const runner = new TurnRunner(
      loop,
      transcript,
      undefined,
      () => new Date(),
      undefined,
      { cwd: directory, transcriptPath: path, collectFileArtifacts: false },
      {
        metadataStore,
        autoGenerateSessionTitle: true,
        sessionTitleGenerator: async input => {
          signal = input.signal;
          return title;
        },
      },
    );
    const router = new SessionRouter({
      createSession: () => new AgentSession({ sessionId, turnRunner: runner }),
      idleSweepIntervalMs: 0,
    });
    try {
      const session = await router.getOrCreate({ sessionKey: sessionId, channelKey: "web" });
      for await (const _ of session.submit({ type: "text", text: "Old request" })) {
        /* drain */
      }
      assert.match(await readFile(path, "utf8"), /Old request/);
      await router.close(sessionId);
      assert.equal(signal?.aborted, true);
      await rm(path);
      if (replace) await writeFile(path, "replacement transcript\n");
      // Deliberately ignore the abort signal, as an incompatible provider can.
      resolveTitle("Obsolete title");
      await new Promise(resolve => setImmediate(resolve));
      // Also exercise old queued callers after closure, not only the title guard.
      await metadataStore.saveAiTitle("Late direct write");
      if (replace) assert.equal(await readFile(path, "utf8"), "replacement transcript\n");
      else await assert.rejects(readFile(path), { code: "ENOENT" });
    } finally {
      resolveTitle("cleanup");
      await router.close(sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("closing a transcript drains in-flight writes and discards queued and future writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sati-writer-close-"));
  const path = join(directory, "session.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  try {
    // M3 写缓冲：flushCheckpoint 前的条目留在 pending，close 时整批被丢弃；
    // 但它们的 ack 仍须 resolve（Sati 适配：上游无 ack 机制，丢弃即悬挂）。
    void writer.recordSessionMetadata("s", "t", { title: "Original" });
    await writer.flushCheckpoint();
    const queued = writer.recordSessionMetadata("s", "t", { aiTitle: "Queued" });
    await writer.close();
    await queued;
    await rm(path);
    await writer.recordSessionMetadata("s", "t", { aiTitle: "Too late" });
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent close and reopen wait for the previous session writer to drain", async () => {
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => {
    finishClose = resolve;
  });
  let created = 0;
  const router = new SessionRouter({
    createSession: () => {
      created++;
      return { dispose: () => closing } as unknown as AgentSession;
    },
    idleSweepIntervalMs: 0,
  });
  const context = { sessionKey: "web:closing", channelKey: "web" };
  await router.getOrCreate(context);
  const firstClose = router.close(context.sessionKey);
  let secondClosed = false;
  const secondClose = router.close(context.sessionKey).then(() => {
    secondClosed = true;
  });
  const reopened = router.getOrCreate(context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondClosed, false);
  assert.equal(created, 1);
  finishClose();
  await Promise.all([firstClose, secondClose, reopened]);
  assert.equal(secondClosed, true);
  assert.equal(created, 2);
  await router.close(context.sessionKey);
});

test("project closure waits for in-progress session creation and blocks new sessions until released", async () => {
  let finishCreate!: (session: AgentSession) => void;
  let disposed = 0;
  const pending = new Promise<AgentSession>(resolve => {
    finishCreate = resolve;
  });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: context =>
      context.projectKey === "/deleting" ? pending : ({ dispose: async () => {} } as unknown as AgentSession),
  });
  const creation = router
    .getOrCreate({ sessionKey: "s", projectKey: "/deleting", channelKey: "web" })
    .catch(error => error);
  let closed = false;
  const closing = router.closeProject("/deleting").then(() => {
    closed = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(
    router.getOrCreate({ sessionKey: "new", projectKey: "/deleting", channelKey: "web" }),
    /being deleted/,
  );
  await router.getOrCreate({ sessionKey: "other", projectKey: "/other", channelKey: "web" });
  finishCreate({
    dispose: async () => {
      disposed++;
    },
  } as unknown as AgentSession);
  await closing;
  assert.match((await creation).message, /being deleted/);
  assert.ok(disposed > 0);
  router.resumeProject("/deleting");
  await router.getOrCreate({ sessionKey: "after", projectKey: "/deleting", channelKey: "web" });
  router.shutdown();
});

test("project closure drains a session already being evicted", async () => {
  let finish!: () => void;
  const drained = new Promise<void>(resolve => {
    finish = resolve;
  });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => ({ dispose: () => drained }) as unknown as AgentSession,
  });
  await router.getOrCreate({ sessionKey: "s", projectKey: "/project", channelKey: "web" });
  const closingSession = router.close("s");
  let closed = false;
  const closingProject = router.closeProject("/project").then(() => {
    closed = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  await Promise.all([closingSession, closingProject]);
  assert.equal(closed, true);
  router.shutdown();
});
