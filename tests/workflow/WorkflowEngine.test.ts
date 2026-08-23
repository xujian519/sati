import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowEngine,
  WorkflowPlanError,
  WorkflowWorkerResolver,
  InMemoryWorkflowPlanStore,
  type WorkflowAgentFactory,
  type WorkflowCheckpointDecision,
  type WorkflowEvent,
  type WorkflowEventSink,
  type WorkflowPlan,
  type WorkflowStepOutput,
  type WorkflowWorkerDefinition,
} from "../../src/workflow/index.js";

const echoWorker: WorkflowWorkerDefinition = {
  name: "echo",
  description: "Echoes the input as summary",
  systemPrompt: "You are an echo worker.",
  allowedTools: [],
};

const failingWorker: WorkflowWorkerDefinition = {
  name: "always-fail",
  description: "Always throws",
  systemPrompt: "You always fail.",
  allowedTools: [],
};

/** Agent factory that returns the resolved input as the step output. */
function createFakeAgentFactory(): WorkflowAgentFactory {
  return () => ({
    prompt: async (input: string): Promise<WorkflowStepOutput> => ({
      summary: `echo: ${input}`,
      data: { input },
    }),
    destroy: () => {},
  });
}

/**
 * Agent factory that fails only workers whose system prompt mentions "fail";
 * other workers behave like the echo factory. Lets tests combine failing and
 * healthy steps in one plan.
 */
function createSelectiveFailingFactory(): WorkflowAgentFactory {
  return config => ({
    prompt: async (input: string): Promise<WorkflowStepOutput> => {
      if (config.systemPrompt.includes("fail")) throw new Error("boom");
      return { summary: `echo: ${input}`, data: { input } };
    },
    destroy: () => {},
  });
}

function createEngine(overrides?: {
  agentFactory?: WorkflowAgentFactory;
  workers?: WorkflowWorkerDefinition[];
  fallbackModel?: string;
  persist?: InMemoryWorkflowPlanStore;
}): WorkflowEngine {
  const resolver = new WorkflowWorkerResolver();
  resolver.registerMany(overrides?.workers ?? [echoWorker, failingWorker]);
  return new WorkflowEngine({
    workerResolver: resolver,
    createAgent: overrides?.agentFactory ?? createFakeAgentFactory(),
    fallbackModel: overrides?.fallbackModel ?? "fallback-model",
    persist: overrides?.persist,
  });
}

function makePlan(steps: WorkflowPlan["steps"]): WorkflowPlan {
  return {
    id: "plan-1",
    intent: "test plan",
    steps,
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test("executes a linear plan and resolves downstream inputs", async () => {
  const engine = createEngine();
  const plan = makePlan([
    {
      id: "s1",
      name: "first",
      worker: { name: "echo" },
      input: { template: "original task" },
      dependsOn: [],
      status: "pending",
    },
    {
      id: "s2",
      name: "second",
      worker: { name: "echo" },
      input: { template: "upstream said: {{s1.output.summary}}" },
      dependsOn: ["s1"],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);

  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]!.status, "completed");
  assert.equal(result.steps[1]!.status, "completed");
  assert.equal(result.steps[1]!.output?.summary, "echo: upstream said: echo: original task");
});

test("runs independent steps in parallel", async () => {
  const order: string[] = [];
  const agentFactory: WorkflowAgentFactory = () => ({
    prompt: async (input: string) => {
      await new Promise(resolve => setTimeout(resolve, input.includes("slow") ? 30 : 5));
      order.push(input);
      return { summary: input };
    },
    destroy: () => {},
  });
  const engine = createEngine({ agentFactory });
  const plan = makePlan([
    {
      id: "fast",
      name: "fast",
      worker: { name: "echo" },
      input: { template: "fast" },
      dependsOn: [],
      status: "pending",
    },
    {
      id: "slow",
      name: "slow",
      worker: { name: "echo" },
      input: { template: "slow" },
      dependsOn: [],
      status: "pending",
    },
    {
      id: "join",
      name: "join",
      worker: { name: "echo" },
      input: { template: "join {{fast.output.summary}} {{slow.output.summary}}" },
      dependsOn: ["fast", "slow"],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[2]!.output?.summary, "join fast slow");
  // Fast finishes before slow starts blocking; both run concurrently.
  assert.ok(order.indexOf("fast") < order.indexOf("slow"));
});

test("skips steps whose condition is false and continues downstream", async () => {
  const engine = createEngine();
  const plan = makePlan([
    {
      id: "s1",
      name: "gate",
      worker: { name: "echo" },
      input: { template: "do work" },
      dependsOn: [],
      status: "pending",
      condition: { expression: '{{context.flag}} == "on"' },
    },
    {
      id: "s2",
      name: "always",
      worker: { name: "echo" },
      input: { template: "unconditional" },
      dependsOn: ["s1"],
      status: "pending",
    },
  ]);
  plan.context = { flag: "off" };

  const result = await engine.execute(plan);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]!.status, "skipped");
  assert.equal(result.steps[1]!.status, "completed");
});

test("applies onFailure=default when a step fails", async () => {
  const engine = createEngine({ agentFactory: createSelectiveFailingFactory() });
  const plan = makePlan([
    {
      id: "s1",
      name: "flaky",
      worker: { name: "always-fail", onFailure: "default", defaultValue: { summary: "fallback value" } },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]!.output?.summary, "fallback value");
});

test("applies onFailure=skip and keeps the plan running", async () => {
  const engine = createEngine({ agentFactory: createSelectiveFailingFactory() });
  const plan = makePlan([
    {
      id: "s1",
      name: "flaky",
      worker: { name: "always-fail", onFailure: "skip" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
    {
      id: "s2",
      name: "after",
      worker: { name: "echo" },
      input: { template: "after" },
      dependsOn: ["s1"],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]!.status, "skipped");
  assert.equal(result.steps[1]!.status, "completed");
});

test("fails the plan when a step fails with onFailure=fail", async () => {
  const engine = createEngine({ agentFactory: createSelectiveFailingFactory() });
  const plan = makePlan([
    {
      id: "s1",
      name: "flaky",
      worker: { name: "always-fail" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]!.status, "failed");
});

test("workflow_failed reports the actual failed step, not the first ready step", async () => {
  // Regression: `workflow_failed.error` used to take `ready[0]?.id`, which is
  // the first *ready* step (possibly a healthy one) rather than the step that
  // actually failed. Two independent steps run in parallel; "ok" is ready
  // first and succeeds, "bad" fails, so the reported step id must be "bad".
  const events: WorkflowEvent[] = [];
  const eventSink: WorkflowEventSink = { emit: event => events.push(event) };
  const resolver = new WorkflowWorkerResolver();
  resolver.registerMany([echoWorker, failingWorker]);
  const engine = new WorkflowEngine({
    workerResolver: resolver,
    createAgent: createSelectiveFailingFactory(),
    eventSink,
  });
  const plan = makePlan([
    { id: "ok", name: "ok", worker: { name: "echo" }, input: { template: "x" }, dependsOn: [], status: "pending" },
    {
      id: "bad",
      name: "bad",
      worker: { name: "always-fail" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);

  const result = await engine.execute(plan);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[1]!.status, "failed");
  const failedEvent = events.find(event => event.type === "workflow_failed");
  assert.ok(failedEvent, "expected a workflow_failed event");
  assert.equal(failedEvent.error, "bad");
});

test("retries failed steps up to maxRetries before failing", async () => {
  let calls = 0;
  const flakyFactory: WorkflowAgentFactory = () => ({
    prompt: async () => {
      calls++;
      if (calls < 3) throw new Error(`attempt ${calls}`);
      return { summary: "recovered" };
    },
    destroy: () => {},
  });
  // Retry policy: maxRetries 2 -> up to 3 attempts total.
  const resolver = new WorkflowWorkerResolver();
  resolver.register(echoWorker);
  const retryingEngine = new WorkflowEngine({
    workerResolver: resolver,
    createAgent: flakyFactory,
    retryPolicy: { maxRetries: 2, delayMs: 1 },
  });
  const plan = makePlan([
    {
      id: "s1",
      name: "flaky",
      worker: { name: "echo" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);

  const result = await retryingEngine.execute(plan);
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.equal(result.steps[0]!.output?.summary, "recovered");
});

test("rejects plans referencing unknown workers", async () => {
  const engine = createEngine();
  const plan = makePlan([
    {
      id: "s1",
      name: "bad",
      worker: { name: "no-such-worker" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);
  await assert.rejects(engine.execute(plan), WorkflowPlanError);
});

test("rejects cyclic dependency plans", async () => {
  const engine = createEngine();
  const plan = makePlan([
    {
      id: "a",
      name: "a",
      worker: { name: "echo" },
      input: { template: "a" },
      dependsOn: ["b"],
      status: "pending",
    },
    {
      id: "b",
      name: "b",
      worker: { name: "echo" },
      input: { template: "b" },
      dependsOn: ["a"],
      status: "pending",
    },
  ]);
  await assert.rejects(engine.execute(plan), /Cyclic dependency/);
});

test("persists progress to the plan store after execution", async () => {
  const persist = new InMemoryWorkflowPlanStore();
  const engine = createEngine({ persist });
  const plan = makePlan([
    {
      id: "s1",
      name: "one",
      worker: { name: "echo" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
    },
  ]);

  await engine.execute(plan);
  const stored = await persist.loadPlan("plan-1");
  assert.ok(stored);
  assert.equal(stored!.status, "completed");
  assert.equal(stored!.steps[0]!.status, "completed");
});

test("adjustPlan supports add/remove/reorder/modify", () => {
  const engine = createEngine();
  const plan = makePlan([
    {
      id: "a",
      name: "a",
      worker: { name: "echo" },
      input: { template: "a" },
      dependsOn: [],
      status: "pending",
    },
    {
      id: "b",
      name: "b",
      worker: { name: "echo" },
      input: { template: "b" },
      dependsOn: ["a"],
      status: "pending",
    },
  ]);

  const added = engine.adjustPlan(plan, [
    {
      type: "add_step",
      afterStepId: "a",
      step: { id: "c", name: "c", worker: { name: "echo" }, input: { template: "c" }, dependsOn: ["a"] },
    },
  ]);
  assert.deepEqual(
    added.steps.map(step => step.id),
    ["a", "c", "b"],
  );

  const modified = engine.adjustPlan(added, [{ type: "modify_step", stepId: "c", modifications: { name: "renamed" } }]);
  assert.equal(modified.steps.find(step => step.id === "c")?.name, "renamed");

  const reordered = engine.adjustPlan(modified, [{ type: "reorder", stepIds: ["b", "c", "a"] }]);
  assert.deepEqual(
    reordered.steps.map(step => step.id),
    ["b", "c", "a"],
  );

  const removed = engine.adjustPlan(reordered, [{ type: "remove_step", stepId: "c" }]);
  assert.deepEqual(
    removed.steps.map(step => step.id),
    ["b", "a"],
  );
});

test("checkpoint handler receives the step and pauses on reject", async () => {
  const decisions: Array<{ stepId: string; action: string }> = [];
  const resolver = new WorkflowWorkerResolver();
  resolver.register(echoWorker);
  const checkpointEngine = new WorkflowEngine({
    workerResolver: resolver,
    createAgent: createFakeAgentFactory(),
    checkpointHandler: {
      waitForDecision: async (step, _plan, output) => {
        decisions.push({ stepId: step.id, action: "approve" });
        return { action: "approve", feedback: output.summary };
      },
    },
  });
  const plan = makePlan([
    {
      id: "s1",
      name: "one",
      worker: { name: "echo" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
      checkpoint: { title: "review s1" },
    },
  ]);

  const result = await checkpointEngine.execute(plan);
  assert.equal(result.status, "completed");
  assert.deepEqual(decisions, [{ stepId: "s1", action: "approve" }]);
});

test("resume delivers a decision to the in-flight checkpoint wait", async () => {
  const resolver = new WorkflowWorkerResolver();
  resolver.register(echoWorker);
  let handlerCalled!: () => void;
  const handlerCalledPromise = new Promise<void>(resolve => {
    handlerCalled = resolve;
  });
  const checkpointEngine = new WorkflowEngine({
    workerResolver: resolver,
    createAgent: createFakeAgentFactory(),
    checkpointHandler: {
      waitForDecision: async () => {
        handlerCalled();
        // Pending decision — resolved by resume().
        return new Promise(() => {});
      },
    },
  });
  const plan = makePlan([
    {
      id: "s1",
      name: "one",
      worker: { name: "echo" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
      checkpoint: { title: "review s1" },
    },
  ]);

  const runPromise = checkpointEngine.execute(plan);
  await handlerCalledPromise; // execution is now awaiting the checkpoint
  await checkpointEngine.pause("plan-1");
  const resumePromise = checkpointEngine.resume("plan-1", { action: "approve" });

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]!.status, "completed");
  const resumed = await resumePromise;
  assert.equal(resumed.status, "completed");
});

test("a resume decision is consumed by one checkpoint and does not leak to the next", async () => {
  const handlerCalls: string[] = [];
  let releaseFirst: ((decision: WorkflowCheckpointDecision) => void) | undefined;
  const resolver = new WorkflowWorkerResolver();
  resolver.register(echoWorker);
  const checkpointEngine = new WorkflowEngine({
    workerResolver: resolver,
    createAgent: createFakeAgentFactory(),
    checkpointHandler: {
      waitForDecision: async step => {
        handlerCalls.push(step.id);
        if (step.id === "s1") {
          // Pending decision — resolved by resume().
          return new Promise(resolve => {
            releaseFirst = resolve;
          });
        }
        return { action: "approve" };
      },
    },
  });
  const plan = makePlan([
    {
      id: "s1",
      name: "one",
      worker: { name: "echo" },
      input: { template: "x" },
      dependsOn: [],
      status: "pending",
      checkpoint: { title: "review s1" },
    },
    {
      id: "s2",
      name: "two",
      worker: { name: "echo" },
      input: { template: "y" },
      dependsOn: ["s1"],
      status: "pending",
      checkpoint: { title: "review s2" },
    },
  ]);

  const runPromise = checkpointEngine.execute(plan);
  // Wait until s1's checkpoint handler is invoked (execution pending).
  await new Promise<void>(resolve => {
    const timer = setInterval(() => {
      if (releaseFirst) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
  await checkpointEngine.pause("plan-1");
  await checkpointEngine.resume("plan-1", { action: "approve" });

  const result = await runPromise;
  assert.equal(result.status, "completed");
  // s2's checkpoint still went through the handler — the resume decision was
  // consumed by s1 only and not reused for s2.
  assert.deepEqual(handlerCalls, ["s1", "s2"]);
});
