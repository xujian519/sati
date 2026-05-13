import test from "node:test";
import assert from "node:assert/strict";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import { createModelRuntime } from "../../src/model/index.js";
import { loadPilotConfig } from "../../src/pilot/index.js";
import type { RouterTokenSaverConfig } from "../../src/router/config/schema.js";

const RUN = process.env.PILOTDECK_RUN_FRAMEWORK_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";

type BenchmarkEntry = { instruction: string; expectedTier: string; category: string };

const BENCHMARK: BenchmarkEntry[] = [
  { instruction: "What does this function do?", expectedTier: "SIMPLE", category: "simple-qa" },
  { instruction: "Rename the variable foo to bar", expectedTier: "SIMPLE", category: "simple-edit" },
  { instruction: "Write a hello world program", expectedTier: "SIMPLE", category: "simple-gen" },
  { instruction: "Add error handling to this function", expectedTier: "SIMPLE", category: "simple-code" },
  { instruction: "ok", expectedTier: "SIMPLE", category: "boundary" },
  { instruction: "Refactor the entire authentication module from sessions to JWT tokens", expectedTier: "COMPLEX", category: "complex-refactor" },
  { instruction: "Design and implement a complete CI/CD pipeline with testing, staging, and production environments", expectedTier: "COMPLEX", category: "multi-step" },
  { instruction: "Analyze this codebase architecture and provide improvement recommendations with diagrams", expectedTier: "COMPLEX", category: "architecture" },
  { instruction: "Performance is terrible. Profile the app, find all bottlenecks, and optimize them", expectedTier: "COMPLEX", category: "debug" },
  { instruction: "Process these 5 CSV files, merge them, compute statistics, generate charts and a PDF report", expectedTier: "COMPLEX", category: "data-pipeline" },
];

test("Real LLM judge classifies 10 benchmark instructions with >= 80% accuracy", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run real judge classification E2E test.");
    return;
  }

  const snapshot = loadPilotConfig();
  const provider = snapshot.config.model.providers[PROVIDER];
  if (!provider) throw new Error(`Provider ${PROVIDER} not configured.`);

  const modelRuntime = createModelRuntime(snapshot.config.model);

  const config: RouterTokenSaverConfig = {
    enabled: true,
    judge: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL },
    defaultTier: "SIMPLE",
    tiers: {
      SIMPLE: {
        model: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL },
        description: "Simple questions, quick lookups, small single-file edits, reading files, short code generation",
      },
      COMPLEX: {
        model: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL },
        description: "Multi-step tasks, architecture design, large refactors across multiple files, debugging and optimization, data processing pipelines, system design",
      },
    },
    rules: [
      "If the task involves multiple files, multi-step planning, or system-level changes, classify as COMPLEX",
      "If the user message is short, vague, or asks a simple question, classify as SIMPLE",
      "If the task involves debugging, profiling, or root cause analysis, classify as COMPLEX",
    ],
    judgeTimeoutMs: 30_000,
  };

  const results: Array<{ instruction: string; expected: string; actual: string; correct: boolean }> = [];
  const confusion: Record<string, number> = { "SIMPLE→SIMPLE": 0, "SIMPLE→COMPLEX": 0, "COMPLEX→SIMPLE": 0, "COMPLEX→COMPLEX": 0 };

  for (const entry of BENCHMARK) {
    const decision = await classifyAndRoute({
      config,
      messages: [{ role: "user", content: [{ type: "text", text: entry.instruction }] }],
      judgeRuntime: modelRuntime,
    });

    const actual = decision?.tier ?? "UNKNOWN";
    const correct = actual === entry.expectedTier;
    results.push({ instruction: entry.instruction.slice(0, 60), expected: entry.expectedTier, actual, correct });

    const key = `${entry.expectedTier}→${actual}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }

  console.log("\n=== Judge Classification Results ===");
  for (const r of results) {
    console.log(`  ${r.correct ? "✓" : "✗"} [${r.expected}→${r.actual}] ${r.instruction}`);
  }
  console.log("\n=== Confusion Matrix ===");
  for (const [key, count] of Object.entries(confusion)) {
    if (count > 0) console.log(`  ${key}: ${count}`);
  }

  const correctCount = results.filter((r) => r.correct).length;
  console.log(`\nAccuracy: ${correctCount}/${results.length} (${(correctCount / results.length * 100).toFixed(0)}%)`);
  assert.ok(correctCount >= 8, `Expected >= 8/10 correct, got ${correctCount}/10`);
});
