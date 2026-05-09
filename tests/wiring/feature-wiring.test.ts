// Wiring contract tests.
//
// Each test asserts that one **already-implemented** wave feature is actually
// wired into the production entry point (`src/cli/createLocalGateway.ts`).
// They deliberately combine two flavors:
//
//   * Dynamic: spin up a real `createBuiltinRegistry()` /
//     `createLocalGateway(...)` and inspect what got constructed (preferred).
//
//   * Structural: read the source of `createLocalGateway.ts` as text and
//     assert specific patterns. Fragile in theory, but precise about the
//     wiring decision and easy to keep in sync after a fix lands.
//
// A failing test here means the underlying code shipped (handlers, classes,
// schema) but **nothing in production constructs / passes it through to the
// AgentLoop**. Once the wire is added, the test should turn green without
// touching the assertion text.
//
// References:
//   - docs/pilotdeck-deferred-feature-implementation-guide.md (wave A/B/C
//     feature catalog).
//   - src/cli/createLocalGateway.ts (the single production wire point).
//   - src/agent/loop/AgentLoop.ts (`createToolContext`).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createBuiltinRegistry } from "../../src/tool/index.js";

// Resolve repo root by walking up from cwd until we find package.json. `npm
// test` runs from the project root, but be defensive — the compiled test
// lives in `dist/tests/wiring/...` and we need to read **the source** files
// (under `src/`), not the compiled .js.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate repo root from ${process.cwd()}`);
}
const ROOT = findRepoRoot();

const createLocalGatewaySrc = readFileSync(
  path.join(ROOT, "src/cli/createLocalGateway.ts"),
  "utf8",
);
const agentLoopSrc = readFileSync(
  path.join(ROOT, "src/agent/loop/AgentLoop.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Wave A — context / tokens
// ---------------------------------------------------------------------------

test("WIRING A1 worktree lookup is wired (findCanonicalProjectRoot used by pilot/paths)", () => {
  // A1 is wired through `src/pilot/paths.ts` which calls findCanonicalProjectRoot.
  // No assertion about createLocalGateway needed — the entry uses pilotHome /
  // paths via loadPilotConfig already; the canonical-root resolution is the
  // wired path.
  const paths = readFileSync(path.join(ROOT, "src/pilot/paths.ts"), "utf8");
  assert.match(
    paths,
    /findCanonicalProjectRoot\(/,
    "pilot/paths must call findCanonicalProjectRoot to honour worktree lookup",
  );
});

test("WIRING A2 real tokenizer fallback is plumbed through TokenBudgetManager into context", () => {
  // A2: the `TokenBudgetManager` should accept a real tokenizer fallback
  // (provider-aware) and createLocalGateway should pass one in. Today
  // `createLocalGateway` never instantiates a TokenBudgetManager nor passes
  // a tokenizer anywhere, so this fails until A2 is actually wired.
  assert.match(
    createLocalGatewaySrc,
    /TokenBudgetManager|providerTokenizer|tokenEstimator/,
    "createLocalGateway must wire a tokenizer / TokenBudgetManager into the context runtime",
  );
});

test("WIRING A3 structured_output tool is registered in the production builtin registry", () => {
  const registry = createBuiltinRegistry();
  const names = registry.list().map((t) => t.name);
  assert.ok(
    names.includes("structured_output"),
    `structured_output not in builtin registry. Got: ${names.join(", ")}`,
  );
});

test("WIRING A4 cached microcompact engine is constructed when context.cachedMicrocompactEnabled is on", () => {
  // A4: createLocalGateway should construct a CachedMicroCompactionEngine and
  // hand it to the context runtime when config.context.cachedMicrocompactEnabled.
  // Today nobody news the engine in the production path.
  assert.match(
    createLocalGatewaySrc,
    /CachedMicroCompactionEngine/,
    "createLocalGateway must construct CachedMicroCompactionEngine",
  );
});

test("WIRING A5 snip compact strategy is reachable from the production CompactionEngine wire", () => {
  // A5: same wire as A4 — the CompactionEngine constructed in production must
  // be configured with the snip strategy. Today CompactionEngine is never
  // instantiated outside tests.
  assert.match(
    createLocalGatewaySrc,
    /CompactionEngine|AutoCompactionPolicy/,
    "createLocalGateway must construct CompactionEngine / AutoCompactionPolicy",
  );
});

// ---------------------------------------------------------------------------
// Wave B — elicitation / web fetch / MCP instructions
// ---------------------------------------------------------------------------

test("WIRING B1 ask_user_question tool is registered in the production builtin registry", () => {
  const registry = createBuiltinRegistry();
  const names = registry.list().map((t) => t.name);
  assert.ok(
    names.includes("ask_user_question"),
    `ask_user_question not in builtin registry. Got: ${names.join(", ")}`,
  );
});

test("WIRING B1 elicitation channel is wired into the AgentLoop tool runtime context", () => {
  // ask_user_question.execute() reads context.elicitation. Even if the tool
  // is registered, the wire is broken unless AgentLoop populates
  // `elicitation` in `createToolContext`.
  assert.match(
    agentLoopSrc,
    /elicitation:\s*(this\.dependencies|input\.|context)/,
    "AgentLoop.createToolContext must pass `elicitation` from dependencies",
  );
});

test("WIRING B2 web_fetch tool is registered in the production builtin registry", () => {
  const registry = createBuiltinRegistry();
  const names = registry.list().map((t) => t.name);
  assert.ok(
    names.includes("web_fetch"),
    `web_fetch not in builtin registry. Got: ${names.join(", ")}`,
  );
});

test("WIRING B3 MCP instructions flow from PluginRuntime through ExtensionResolver into PromptAssembler", async () => {
  // B3 already lives in `PluginRuntimeExtensionResolver.listMcpInstructions()`
  // (verified by grep). createLocalGateway uses that resolver — assert the
  // wire is intact.
  assert.match(
    createLocalGatewaySrc,
    /PluginRuntimeExtensionResolver/,
    "createLocalGateway must construct PluginRuntimeExtensionResolver",
  );

  // PluginRuntimeExtensionResolver must expose listMcpInstructions.
  const resolverSrc = readFileSync(
    path.join(ROOT, "src/context/extension/PluginRuntimeExtensionResolver.ts"),
    "utf8",
  );
  assert.match(resolverSrc, /listMcpInstructions/);
});

// ---------------------------------------------------------------------------
// Wave C — MCP runtime, subagent, sidechain, file history, background tasks
// ---------------------------------------------------------------------------

test("WIRING C1 MCP runtime is constructed and tools are bridged into the registry", () => {
  // C1: when `snapshot.config.mcpServers` (or wherever the spec list lives)
  // is non-empty, createLocalGateway should construct an `McpRuntime`, await
  // `createMcpToolDefinitionsFromRuntime`, and merge the resulting tool defs
  // into the per-project ToolRegistry.
  assert.match(
    createLocalGatewaySrc,
    /McpRuntime|createMcpToolDefinitionsFromRuntime/,
    "createLocalGateway must construct McpRuntime and bridge MCP tools into the registry",
  );
});

test("WIRING C2 subagent fork API is constructed in AgentLoop.createToolContext", () => {
  assert.match(
    agentLoopSrc,
    /subagent:\s*this\.buildSubagentForkApi/,
    "AgentLoop.createToolContext must populate `subagent` via buildSubagentForkApi",
  );
});

test("WIRING C3 sidechain transcript hooks are injected via dependencies.subagentTranscript", () => {
  // The agent tool's fork() reads `dependencies.subagentTranscript` to record
  // subagent_started/_completed. createLocalGateway must construct the hooks
  // and pass them through.
  assert.match(
    createLocalGatewaySrc,
    /subagentTranscript:/,
    "createLocalGateway must inject `subagentTranscript` into AgentRuntimeDependencies",
  );
});

test("WIRING C4 file history sink is injected into the AgentLoop tool runtime context", () => {
  // C4: edit_file / write_file rely on `context.fileHistory.trackEdit(...)`.
  // The sink is supposed to be wired by AgentLoop.createToolContext from a
  // `dependencies.fileHistory` or per-session storage. Today AgentLoop never
  // sets `fileHistory`, so this fails.
  assert.match(
    agentLoopSrc,
    /fileHistory:\s*(this\.dependencies|input\.|messageId|context)/,
    "AgentLoop.createToolContext must populate `fileHistory` from dependencies",
  );
});

test("WIRING C4 messageId is set on the tool runtime context (so trackEdit can group)", () => {
  assert.match(
    agentLoopSrc,
    /messageId:/,
    "AgentLoop.createToolContext must set `messageId` for fileHistory grouping",
  );
});

test("WIRING C5 background task runtime is constructed and task_* tools are registered", () => {
  // C5: createLocalGateway should `new BackgroundTaskRuntime()`, then pass
  // it through `createBuiltinRegistry({ backgroundTasks: { runtime } })`.
  assert.match(
    createLocalGatewaySrc,
    /BackgroundTaskRuntime/,
    "createLocalGateway must construct BackgroundTaskRuntime",
  );
  assert.match(
    createLocalGatewaySrc,
    /backgroundTasks:\s*\{\s*runtime/,
    "createLocalGateway must pass the runtime via createBuiltinRegistry({ backgroundTasks: { runtime } })",
  );
});

// ---------------------------------------------------------------------------
// Cross-cutting: memory / tool result budget / context tokenizer
// ---------------------------------------------------------------------------

test("WIRING memory: EdgeClawMemoryProvider is constructed when config.memory.enabled", () => {
  assert.match(
    createLocalGatewaySrc,
    /EdgeClawMemoryProvider/,
    "createLocalGateway must construct EdgeClawMemoryProvider when snapshot.config.memory.enabled",
  );
});

test("WIRING memory: DefaultContextRuntime receives a memoryResolver", () => {
  // The DefaultContextRuntime block in createLocalGateway must include
  // `memoryResolver:` when config.memory is enabled. Currently the
  // construction passes only { extension, projectRoot, now }.
  const ctxBlock = createLocalGatewaySrc.match(
    /new DefaultContextRuntime\(\{[\s\S]*?\}\)/,
  )?.[0];
  assert.ok(ctxBlock, "DefaultContextRuntime block not found in createLocalGateway");
  assert.match(
    ctxBlock!,
    /memoryResolver/,
    "DefaultContextRuntime must be constructed with `memoryResolver`",
  );
});

test("WIRING memory: AgentSession invokes memory.captureTurn after each turn", () => {
  // The capture hook should live somewhere reachable from createLocalGateway.
  // Search the cli + agent + session subtrees for a captureTurn invocation.
  const candidates = [
    path.join(ROOT, "src/cli/createLocalGateway.ts"),
    path.join(ROOT, "src/agent/loop/AgentLoop.ts"),
    path.join(ROOT, "src/agent/runtime/AgentRuntimeDependencies.ts"),
    path.join(ROOT, "src/session/transcript/JsonlTranscriptWriter.ts"),
  ];
  const matched = candidates.some((file) => /captureTurn/.test(readFileSync(file, "utf8")));
  assert.ok(
    matched,
    "No captureTurn invocation found in any production wiring file (expected at AgentLoop turn-completed boundary or createLocalGateway dependency wire)",
  );
});

test("WIRING tool-result-budget: ToolResultBudget is constructed and DefaultContextRuntime receives it", () => {
  assert.match(
    createLocalGatewaySrc,
    /ToolResultBudget/,
    "createLocalGateway must construct ToolResultBudget",
  );
  const ctxBlock = createLocalGatewaySrc.match(
    /new DefaultContextRuntime\(\{[\s\S]*?\}\)/,
  )?.[0];
  assert.match(
    ctxBlock ?? "",
    /toolResultBudget/,
    "DefaultContextRuntime must receive `toolResultBudget`",
  );
});

test("WIRING tool-result-budget: AgentLoop calls contextRuntime.applyToolResults after each tool result", () => {
  // applyToolResults is the hook that actually invokes ToolResultBudget.
  // Even if ToolResultBudget is wired, large results stay in the prompt
  // unless AgentLoop calls `applyToolResults`.
  assert.match(
    agentLoopSrc,
    /applyToolResults/,
    "AgentLoop must call contextRuntime.applyToolResults to spill large tool results",
  );
});

// ---------------------------------------------------------------------------
// Router / Cron — recently landed by colleague; verify their wire too
// ---------------------------------------------------------------------------

test("WIRING router: RouterRuntime is constructed by createLocalGateway", () => {
  assert.match(createLocalGatewaySrc, /createRouterRuntime/);
});

test("WIRING router: AgentRuntimeDependencies.router replaces the legacy `model` field in production wire", () => {
  // After the colleague's router merge, AgentLoop reads dependencies.router.
  // createLocalGateway must wire it accordingly.
  assert.match(
    createLocalGatewaySrc,
    /router:\s*runtime\.router|router:\s*[a-zA-Z]+\.router/,
    "createLocalGateway dependencies must pass `router: runtime.router`",
  );
});

test("WIRING cron: GatewayCronController is accepted via options and forwarded to createGateway", () => {
  assert.match(
    createLocalGatewaySrc,
    /cron:\s*options\.cron/,
    "createLocalGateway must forward the optional cron controller to createGateway",
  );
});
