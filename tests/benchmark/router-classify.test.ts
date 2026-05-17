import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllTasks, type Task } from "./taskLoader.js";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import { parseTier } from "../../src/router/tokenSaver/parseTier.js";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import type { RouterTokenSaverConfig, RouterModelRef } from "../../src/router/config/schema.js";
import type {
  CanonicalModelResponse,
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelCapabilities,
} from "../../src/model/index.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// At runtime __dirname is dist/tests/benchmark/; walk up to PilotDeck root
// then up one more to the claw workspace containing skill/.
const PILOTDECK_ROOT = path.resolve(__dirname, "../../..");
const TASKS_DIR = path.join(PILOTDECK_ROOT, "..", "skill", "tasks");

const RUN_E2E = process.env.PILOTDECK_RUN_ROUTER_CLASSIFY_E2E === "1";

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

/**
 * SIMPLE   — trivial: greetings, confirmations, single-step Q&A, short writes
 * MEDIUM   — single tool calls, short text generation, 1-2 file read/write
 * COMPLEX  — triggers auto-orchestrate (sub-agent spawning); not expected for
 *            PinchBench single-agent tasks
 * REASONING — deep single-agent work: multi-file ops, data analysis,
 *             multi-step workflows, structured reports
 */

const ref = (name: string): RouterModelRef => ({
  id: `test/${name}`,
  provider: "test",
  model: name,
});

const FOUR_TIER_CONFIG: RouterTokenSaverConfig = {
  enabled: true,
  judge: ref("judge"),
  defaultTier: "medium",
  judgeTimeoutMs: 15_000,
  tiers: {
    simple: {
      model: ref("fast"),
      description:
        "Simple greetings, confirmations, single-step Q&A, trivial file writes",
    },
    medium: {
      model: ref("balanced"),
      description:
        "Single tool call, short text generation, 1-2 file read/write, code generation",
    },
    complex: {
      model: ref("orchestrator"),
      description:
        "Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents",
    },
    reasoning: {
      model: ref("deep"),
      description:
        "Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources",
    },
  },
  rules: [
    "complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work",
    "Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning",
    "Simple file creation (1-2 files) or single code generation is medium",
    "Trivial greetings or reading one file and answering a short question is simple",
  ],
};

const KNOWN_TIERS = Object.keys(FOUR_TIER_CONFIG.tiers);

// ---------------------------------------------------------------------------
// Expected tier for each PinchBench task
//
// Key insight: COMPLEX triggers orchestration (sub-agents). PinchBench tasks
// are all single-agent, so none should be COMPLEX. Complex-but-single-agent
// work goes to REASONING.
// ---------------------------------------------------------------------------

const EXPECTED_TIERS: Record<string, string> = {
  task_00_sanity: "simple",       // "Say hello" — trivial
  task_01_calendar: "medium",     // Schedule meeting → single tool
  task_02_stock: "medium",        // Research stock → search + write file
  task_03_blog: "medium",         // Write 500-word blog → text gen + file
  task_04_weather: "medium",      // Create weather.py → code gen + file
  task_05_summary: "medium",      // Read doc, write summary → read + write
  task_06_events: "reasoning",    // Find 5 conferences → web search + structured output
  task_07_email: "medium",        // Draft email → structured writing + file save tool
  task_08_memory: "medium",       // Read notes.md + extract info → file read tool + synthesis
  task_09_files: "medium",        // Create 4 files (src/, main.py, README, .gitignore)
  task_10_workflow: "reasoning",  // Read config → extract API → write script → document
  task_11_clawdhub: "medium",     // Create project scaffold → multiple file writes, no deep analysis
  task_12_skill_search: "reasoning", // Search & replace across multiple config files
  task_13_image_gen: "medium",    // Generate image → single tool call
  task_14_humanizer: "reasoning", // Install plugin + read + rewrite blog
  task_15_daily_summary: "reasoning", // Read multiple research files → executive summary
  task_16_email_triage: "reasoning",  // Triage 13 emails → priority classification + report
  task_17_email_search: "reasoning",  // Search emails for topic → structured summary
  task_16_market_research: "reasoning", // Competitive landscape → web search + deep report (file: task_18)
  task_18_spreadsheet_summary: "reasoning", // CSV + Excel analysis → calculations + report (file: task_19)
  task_20_eli5_pdf_summary: "reasoning",    // Read PDF → ELI5 simplification
  task_21_openclaw_comprehension: "reasoning", // 8 questions from PDF → precise answers
};

// ---------------------------------------------------------------------------
// Mock judge: returns a scripted tier for each task prompt
// ---------------------------------------------------------------------------

function createMockJudgeRuntime(
  tierResponses: Map<string, string>,
): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream not used by classifyAndRoute");
    },
    async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      const promptText = request.messages
        .flatMap((m) =>
          m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text),
        )
        .join("\n");

      // Find which task's prompt is embedded in the judge prompt
      for (const [key, tier] of tierResponses) {
        if (promptText.includes(key)) {
          return {
            role: "assistant",
            content: [{ type: "text", text: `<tier>${tier}</tier>` }],
            finishReason: "stop",
          };
        }
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: `<tier>medium</tier>` }],
        finishReason: "stop",
      };
    },
    getCapabilities(): ModelCapabilities {
      return {
        supportsToolUse: false,
        supportsStreaming: false,
        supportsParallelToolCalls: false,
        supportsThinking: false,
        supportsJsonSchema: false,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 8192,
        maxOutputTokens: 256,
      };
    },
    getMultimodal() { return { input: ["text" as const] }; },
  };
}

// ---------------------------------------------------------------------------
// Unit tests (mock judge)
// ---------------------------------------------------------------------------

test("generateJudgePrompt includes tier descriptions and rules", () => {
  const prompt = generateJudgePrompt({
    userMessage: "Hello world",
    config: FOUR_TIER_CONFIG,
  });
  assert.ok(prompt.includes("simple"));
  assert.ok(prompt.includes("medium"));
  assert.ok(prompt.includes("complex"));
  assert.ok(prompt.includes("reasoning"));
  assert.ok(prompt.includes("sub-agent orchestration"));
  assert.ok(prompt.includes("Hello world"));
  assert.ok(prompt.includes("Routing rules:"));
});

test("parseTier parses lowercase tier tags", () => {
  assert.equal(parseTier("<tier>simple</tier>", KNOWN_TIERS), "simple");
  assert.equal(parseTier("<tier>reasoning</tier>", KNOWN_TIERS), "reasoning");
  assert.equal(parseTier("<tier>complex</tier>", KNOWN_TIERS), "complex");
});

test("parseTier parses uppercase tag content via lowercasing", () => {
  // parseTier lowercases the capture, so uppercase input works with lowercase keys
  assert.equal(parseTier("<tier>SIMPLE</tier>", KNOWN_TIERS), "simple");
  assert.equal(parseTier("<tier>REASONING</tier>", KNOWN_TIERS), "reasoning");
});

test("parseTier falls back to substring match", () => {
  assert.equal(parseTier("I think this is reasoning level", KNOWN_TIERS), "reasoning");
});

test("classifyAndRoute with mock judge returns expected tier", async () => {
  const responses = new Map<string, string>();
  responses.set("Hello, I'm ready", "simple");
  responses.set("Schedule a meeting", "medium");
  responses.set("Find 5 upcoming tech conferences", "reasoning");

  const judge = createMockJudgeRuntime(responses);
  const result = await classifyAndRoute({
    config: FOUR_TIER_CONFIG,
    messages: [
      { role: "user", content: [{ type: "text", text: 'Say "Hello, I\'m ready!" to confirm you can respond.' }] },
    ],
    judgeRuntime: judge,
  });
  assert.ok(result);
  assert.equal(result.tier, "simple");
  assert.equal(result.resolvedFrom, "judge");
});

test("mock judge classifies all 22 tasks to expected tiers", async () => {
  let tasks: Task[];
  try {
    tasks = await loadAllTasks(TASKS_DIR);
  } catch {
    return; // skip if skill dir not available
  }

  // Build mock: keyed by a unique substring of each task's prompt
  const responses = new Map<string, string>();
  for (const task of tasks) {
    const expected = EXPECTED_TIERS[task.taskId];
    if (expected) {
      const key = task.prompt.slice(0, 40);
      responses.set(key, expected);
    }
  }

  const judge = createMockJudgeRuntime(responses);
  const results: Array<{ taskId: string; expected: string; actual: string; ok: boolean }> = [];

  for (const task of tasks) {
    const expected = EXPECTED_TIERS[task.taskId];
    if (!expected) continue;

    const decision = await classifyAndRoute({
      config: FOUR_TIER_CONFIG,
      messages: [{ role: "user", content: [{ type: "text", text: task.prompt }] }],
      judgeRuntime: judge,
    });
    const actual = decision?.tier ?? "UNKNOWN";
    results.push({ taskId: task.taskId, expected, actual, ok: actual === expected });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 0, `${failed.length} tasks misclassified: ${JSON.stringify(failed)}`);
  assert.equal(passed, Object.keys(EXPECTED_TIERS).length);
});

// ---------------------------------------------------------------------------
// E2E test (real judge model)
// ---------------------------------------------------------------------------

test("E2E: real judge model classifies PinchBench tasks", { timeout: 300_000 }, async (t) => {
  if (!RUN_E2E) {
    t.skip("Set PILOTDECK_RUN_ROUTER_CLASSIFY_E2E=1 to run with a real judge model.");
    return;
  }

  const { createModelRuntime } = await import("../../src/model/index.js");
  const { parseModelConfig } = await import("../../src/model/config/parseModelConfig.js");
  const { installGlobalProxy } = await import("../../src/cli/proxy.js");
  const { readFile } = await import("node:fs/promises");
  const { default: YAML } = await import("yaml");
  const { homedir } = await import("node:os");

  // Install proxy so OpenRouter and other providers work behind a firewall
  installGlobalProxy();

  const configPath = path.join(homedir(), ".pilotdeck", "pilotdeck.yaml");
  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = YAML.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    t.skip(`Cannot read ${configPath}: ${err}`);
    return;
  }

  const rawModel = rawConfig.model as Record<string, unknown> | undefined;
  if (!rawModel?.providers) {
    t.skip("No model providers configured in pilotdeck.yaml");
    return;
  }

  const modelConfig = parseModelConfig(rawModel);
  const modelRuntime = createModelRuntime(modelConfig);

  // Resolve judge model: env override > pilotdeck.yaml tokenSaver.judge > first available provider
  const judgeOverride = process.env.PILOTDECK_JUDGE_MODEL; // e.g. "edgeclaw/gpt-4o"
  let judgeRef: RouterModelRef;
  if (judgeOverride) {
    const sep = judgeOverride.indexOf("/");
    judgeRef = { id: judgeOverride, provider: judgeOverride.slice(0, sep), model: judgeOverride.slice(sep + 1) };
  } else {
    const routerCfg = rawConfig.router as Record<string, unknown> | undefined;
    const tsCfg = routerCfg?.tokenSaver as Record<string, unknown> | undefined;
    if (typeof tsCfg?.judge === "string") {
      const sep = (tsCfg.judge as string).indexOf("/");
      judgeRef = {
        id: tsCfg.judge as string,
        provider: (tsCfg.judge as string).slice(0, sep),
        model: (tsCfg.judge as string).slice(sep + 1),
      };
    } else {
      const [provName, prov] = Object.entries(modelConfig.providers)[0];
      const modelName = Object.keys(prov.models)[0];
      judgeRef = { id: `${provName}/${modelName}`, provider: provName, model: modelName };
    }
  }

  const e2eConfig: RouterTokenSaverConfig = {
    ...FOUR_TIER_CONFIG,
    judge: judgeRef,
  };

  let tasks: Task[];
  try {
    tasks = await loadAllTasks(TASKS_DIR);
  } catch (err) {
    t.skip(`Cannot load tasks: ${err}`);
    return;
  }

  console.log(`  Judge model: ${judgeRef.id}`);
  console.log(`  Tasks loaded: ${tasks.length}`);

  // Diagnostic: show raw judge response for first task
  const sampleTask = tasks[0];
  if (sampleTask) {
    const samplePrompt = generateJudgePrompt({
      userMessage: sampleTask.prompt,
      config: e2eConfig,
    });
    try {
      const sampleResp = await modelRuntime.complete({
        provider: judgeRef.provider,
        model: judgeRef.model,
        messages: [{ role: "user", content: [{ type: "text", text: samplePrompt }] }],
        maxOutputTokens: 256,
        temperature: 0,
        stream: false,
      });
      const rawText = sampleResp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(`  [DIAG] Sample task: ${sampleTask.taskId}`);
      console.log(`  [DIAG] Raw judge response: "${rawText}"`);
      const parsed = parseTier(rawText, Object.keys(e2eConfig.tiers));
      console.log(`  [DIAG] parseTier result: ${parsed ?? "undefined"}\n`);
    } catch (err: unknown) {
      const e = err as Error & { error?: { code?: string; status?: number; message?: string; raw?: unknown } };
      console.log(`  [DIAG] Judge call failed: ${e.message}`);
      if (e.error) {
        console.log(`  [DIAG] code=${e.error.code} status=${e.error.status}`);
        console.log(`  [DIAG] raw=${JSON.stringify(e.error.raw)?.slice(0, 300)}`);
      }
      console.log("");
    }
  }

  const results: Array<{
    taskId: string;
    expected: string;
    actual: string;
    ok: boolean;
    resolvedFrom: string;
  }> = [];

  for (const task of tasks) {
    const expected = EXPECTED_TIERS[task.taskId];
    if (!expected) continue;

    const decision = await classifyAndRoute({
      config: e2eConfig,
      messages: [{ role: "user", content: [{ type: "text", text: task.prompt }] }],
      judgeRuntime: modelRuntime,
    });

    const actual = decision?.tier ?? "UNKNOWN";
    const resolvedFrom = decision?.resolvedFrom ?? "none";
    const failureReason = decision?.failureReason ?? "";
    const ok = actual === expected;
    results.push({ taskId: task.taskId, expected, actual, ok, resolvedFrom });

    const icon = ok ? "[OK]" : "[!!]";
    const suffix = failureReason ? ` (${failureReason})` : "";
    console.log(
      `  ${icon} ${task.taskId.padEnd(35)} expected=${expected.padEnd(10)} actual=${actual.padEnd(10)} via=${resolvedFrom}${suffix}`,
    );
  }

  // Print summary
  const tierGroups = new Map<string, { total: number; correct: number }>();
  for (const r of results) {
    const g = tierGroups.get(r.expected) ?? { total: 0, correct: 0 };
    g.total++;
    if (r.ok) g.correct++;
    tierGroups.set(r.expected, g);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Router Classification Accuracy Report");
  console.log(`${"=".repeat(60)}`);
  for (const tier of ["simple", "medium", "complex", "reasoning"]) {
    const g = tierGroups.get(tier);
    if (!g) continue;
    const pct = g.total > 0 ? ((g.correct / g.total) * 100).toFixed(0) : "N/A";
    console.log(`  ${tier.padEnd(12)} ${g.correct}/${g.total}  (${pct}%)`);
  }
  const totalCorrect = results.filter((r) => r.ok).length;
  const totalTasks = results.length;
  const overallPct = totalTasks > 0 ? ((totalCorrect / totalTasks) * 100).toFixed(1) : "N/A";
  console.log(`  ${"Overall".padEnd(12)} ${totalCorrect}/${totalTasks}  (${overallPct}%)`);
  console.log(`${"=".repeat(60)}`);

  // Show mismatches
  const mismatches = results.filter((r) => !r.ok);
  if (mismatches.length > 0) {
    console.log("\nMismatches:");
    for (const m of mismatches) {
      console.log(`  ${m.taskId}: expected ${m.expected}, got ${m.actual}`);
    }
  }

  // Soft assertion: allow up to 3 mismatches for real model variance
  assert.ok(
    totalCorrect >= totalTasks - 3,
    `Too many misclassifications: ${totalCorrect}/${totalTasks} correct (${mismatches.length} wrong)`,
  );
});
