import test from "node:test";
import assert from "node:assert/strict";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { PluginRuntimeExtensionResolver } from "../../src/context/extension/PluginRuntimeExtensionResolver.js";
import { PluginRuntime } from "../../src/extension/index.js";
import type { CanonicalMessage, CanonicalModelError } from "../../src/model/index.js";

const baseInput = {
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "/tmp/proj",
  provider: "edgeclaw",
  model: "moonshotai/kimi-k2.6",
  permissionMode: "default",
  additionalWorkingDirectories: [],
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
  tools: [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }],
};

test("DefaultContextRuntime.prepareForModel returns ModelContext with assembled prompt", async () => {
  const runtime = new DefaultContextRuntime();
  const context = await runtime.prepareForModel(baseInput);
  assert.equal(context.messages.length, 1);
  assert.ok(context.systemPrompt && context.systemPrompt.length > 0);
  assert.match(context.systemPrompt!, /You are PilotDeck/);
  assert.equal(context.tools.length, 1);
  assert.equal(context.diagnostics.length, 0);
});

test("DefaultContextRuntime.prepareForModel injects placeholder and surfaces diagnostic for missing tool_result", async () => {
  const runtime = new DefaultContextRuntime();
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "text", text: "no tool result" }] },
  ];
  const context = await runtime.prepareForModel({ ...baseInput, messages });
  assert.ok(context.diagnostics.some((d) => d.code === "tool_result_injected"));
  const injected = context.messages.find(
    (m) => m.content.some((b) => b.type === "tool_result" && b.toolCallId === "call-1"),
  );
  assert.ok(injected, "placeholder tool_result should be injected");
});

test("DefaultContextRuntime includes PluginRuntime commands and skills in the system prompt", async () => {
  const pluginRuntime = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "review",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "review" },
        commands: [
          {
            name: "review:check",
            path: "<builtin>/commands/check.md",
            content: "Check",
            frontmatter: { description: "Run review checks" },
            isSkill: false,
          },
        ],
        skills: [
          {
            name: "review:focus",
            path: "<builtin>/skills/focus/SKILL.md",
            content: "Focus",
            frontmatter: { description: "Focus on risky code" },
            isSkill: true,
          },
        ],
      },
    ],
  });
  await pluginRuntime.refresh();

  const runtime = new DefaultContextRuntime({
    extension: new PluginRuntimeExtensionResolver(pluginRuntime),
  });
  const context = await runtime.prepareForModel(baseInput);

  assert.match(context.systemPrompt!, /\/review:check/);
  assert.match(context.systemPrompt!, /review:focus/);
});

test("DefaultContextRuntime.applyToolResults appends the message", async () => {
  const runtime = new DefaultContextRuntime();
  const result = await runtime.applyToolResults({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    toolResultMessage: {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }],
    },
  });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1]?.role, "user");
});

test("DefaultContextRuntime.recoverFromModelError returns truncate first then aggressive then give_up", async () => {
  const runtime = new DefaultContextRuntime();
  const ptlError: CanonicalModelError = {
    provider: "anthropic",
    protocol: "anthropic",
    code: "prompt_too_long",
    message: "Prompt is too long",
    retryable: false,
    recoverableViaCompact: true,
  };
  const first = await runtime.recoverFromModelError({
    sessionId: "s",
    turnId: "t",
    error: ptlError,
    messages: [],
    hasAttemptedCompact: false,
  });
  assert.equal(first.type, "truncate_head_and_retry");
  if (first.type === "truncate_head_and_retry") {
    assert.equal(first.keepRatio, 0.5);
    assert.equal(first.reason, "ptl-first-attempt");
  }

  const second = await runtime.recoverFromModelError({
    sessionId: "s",
    turnId: "t",
    error: ptlError,
    messages: [],
    hasAttemptedCompact: true,
  });
  assert.equal(second.type, "give_up");
  if (second.type === "give_up") {
    assert.equal(second.reason, "ptl-exhausted-after-two-attempts");
  }
});

test("DefaultContextRuntime.recoverFromModelError gives up on non-PTL errors", async () => {
  const runtime = new DefaultContextRuntime();
  const otherError: CanonicalModelError = {
    provider: "anthropic",
    protocol: "anthropic",
    code: "rate_limit_error",
    message: "rate limit",
    retryable: true,
  };
  const decision = await runtime.recoverFromModelError({
    sessionId: "s",
    turnId: "t",
    error: otherError,
    messages: [],
    hasAttemptedCompact: false,
  });
  assert.equal(decision.type, "give_up");
  if (decision.type === "give_up") {
    assert.match(decision.reason, /rate_limit_error/);
  }
});

test("DefaultContextRuntime.tryAutoCompact reports a current-history snapshot when no compaction is needed", async () => {
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    maxContextTokens: 100_000,
  });

  const result = await runtime.tryAutoCompact({
    messages: [{ role: "user", content: [{ type: "text", text: "small history" }] }],
  });

  assert.equal(result.type, "skipped");
  assert.ok(result.snapshot.tokens > 0);
  assert.equal(result.snapshot.maxContextTokens, 100_000);
  assert.equal(result.snapshot.state, "ok");
});

test("DefaultContextRuntime.tryAutoCompact returns a post-compaction snapshot after full compaction", async () => {
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: {
      async run() {
        return {
          trigger: "auto" as const,
          preTokens: 0,
          summaryMessage: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "short summary" }],
          },
          boundaryMarker: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "<compact-boundary trigger=\"auto\" />" }],
          },
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        };
      },
    } as never,
    maxContextTokens: 500,
  });

  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "A".repeat(4_000),
        },
      ],
    },
  ];

  const result = await runtime.tryAutoCompact({ messages });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.ok(result.snapshot.tokens > 0);
  assert.equal(result.snapshot.maxContextTokens, 500);
  assert.equal(result.snapshot.state, "ok");
});
