#!/usr/bin/env node
/**
 * PinchBench runner on PilotDeck Gateway.
 *
 * Usage:
 *   npm run build && node dist/tests/benchmark/pinchbench-runner.js \
 *     --skill-dir /path/to/skill \
 *     [--suite all|automated-only|task_00_sanity,task_09_files] \
 *     [--output-dir results] \
 *     [--timeout-multiplier 1.0] \
 *     [--judge openrouter/anthropic/claude-opus-4.5] \
 *     [--verbose]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";

import { loadAllTasks, type Task } from "./taskLoader.js";
import { prepareTaskWorkspace, type TaskWorkspace } from "./workspace.js";
import { executeTask, type ExecutionResult } from "./executor.js";
import { gradeTask, type GradeResult } from "./grading.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    "skill-dir": { type: "string" },
    suite: { type: "string", default: "all" },
    "output-dir": { type: "string", default: "results" },
    "timeout-multiplier": { type: "string", default: "1.0" },
    judge: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

const skillDir = args["skill-dir"] ?? path.resolve(process.cwd(), "../../skill");
const tasksDir = path.join(skillDir, "tasks");
const suite = args["suite"]!;
const outputDir = args["output-dir"]!;
const timeoutMultiplier = parseFloat(args["timeout-multiplier"]!);
const judgeModel = args["judge"];
const verbose = args["verbose"]!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`${ts} - ${msg}\n`);
}

function getGitVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 2000,
      cwd: skillDir,
    }).trim();
  } catch {
    return "";
  }
}

function selectTaskIds(tasks: Task[], suiteArg: string): string[] | undefined {
  if (suiteArg === "all") return undefined;
  if (suiteArg === "automated-only") {
    return tasks.filter((t) => t.gradingType === "automated").map((t) => t.taskId);
  }
  return suiteArg.split(",").map((s) => s.trim()).filter(Boolean);
}

type TaskEntry = {
  task_id: string;
  status: string;
  timed_out: boolean;
  execution_time: number;
  transcript_length: number;
  usage: Record<string, number>;
  workspace: string;
  grading: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
};

type EfficiencySummary = {
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_requests: number;
  total_execution_time_seconds: number;
  tasks_with_usage_data: number;
  tokens_per_task: number;
  cost_per_task_usd: number;
  score_per_1k_tokens: number | null;
  score_per_dollar: number | null;
  per_task: Array<Record<string, unknown>>;
};

function computeEfficiency(
  entries: TaskEntry[],
  grades: Map<string, GradeResult>,
): EfficiencySummary {
  let totalInput = 0;
  let totalOutput = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalRequests = 0;
  let totalExecTime = 0;
  let withUsage = 0;

  const perTask: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const inp = e.usage.input_tokens ?? 0;
    const out = e.usage.output_tokens ?? 0;
    const tot = e.usage.total_tokens ?? 0;
    const cost = e.usage.cost_usd ?? 0;
    const reqs = e.usage.request_count ?? 0;
    totalInput += inp;
    totalOutput += out;
    totalTokens += tot;
    totalCost += cost;
    totalRequests += reqs;
    totalExecTime += e.execution_time;
    if (tot > 0) withUsage++;

    const grade = grades.get(e.task_id);
    const score = grade?.score ?? 0;
    perTask.push({
      task_id: e.task_id,
      score: Math.round(score * 10000) / 10000,
      total_tokens: tot,
      cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
      tokens_per_score_point: score > 0 ? Math.round(tot / score * 10) / 10 : null,
    });
  }

  const numTasks = entries.length || 1;
  const totalScore = [...grades.values()].reduce((sum, g) => sum + g.score, 0);

  return {
    total_tokens: totalTokens,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    total_requests: totalRequests,
    total_execution_time_seconds: Math.round(totalExecTime * 100) / 100,
    tasks_with_usage_data: withUsage,
    tokens_per_task: Math.round(totalTokens / numTasks * 10) / 10,
    cost_per_task_usd: Math.round(totalCost / numTasks * 1_000_000) / 1_000_000,
    score_per_1k_tokens: totalTokens > 0
      ? Math.round(totalScore / (totalTokens / 1000) * 1_000_000) / 1_000_000
      : null,
    score_per_dollar: totalCost > 0
      ? Math.round(totalScore / totalCost * 10000) / 10000
      : null,
    per_task: perTask,
  };
}

function printScoreSummary(
  entries: TaskEntry[],
  tasks: Task[],
  grades: Map<string, GradeResult>,
): void {
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  const cats = new Map<string, { earned: number; possible: number; count: number }>();
  for (const e of entries) {
    const task = taskMap.get(e.task_id);
    const cat = (task?.category ?? "uncategorized").toUpperCase();
    const g = grades.get(e.task_id);
    const prev = cats.get(cat) ?? { earned: 0, possible: 0, count: 0 };
    prev.earned += g?.score ?? 0;
    prev.possible += 1;
    prev.count += 1;
    cats.set(cat, prev);
  }

  const totalEarned = [...cats.values()].reduce((s, c) => s + c.earned, 0);
  const totalPossible = [...cats.values()].reduce((s, c) => s + c.possible, 0);
  const pct = totalPossible > 0 ? (totalEarned / totalPossible) * 100 : 0;

  log(`\n${"=".repeat(80)}`);
  log("PINCHBENCH SCORE SUMMARY (PilotDeck)");
  log(`${"=".repeat(80)}`);
  log(`   Overall Score: ${pct.toFixed(1)}% (${totalEarned.toFixed(1)} / ${totalPossible.toFixed(1)})`);

  for (const [cat, data] of [...cats.entries()].sort()) {
    const cp = data.possible > 0 ? (data.earned / data.possible) * 100 : 0;
    const icon = cp >= 90 ? "[OK]" : cp >= 70 ? "[--]" : "[!!]";
    log(`   ${icon} ${cat.padEnd(20)} ${cp.toFixed(1).padStart(6)}%  ${data.count} task(s)`);
  }
  log(`${"=".repeat(80)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("PinchBench on PilotDeck — starting");

  const allTasks = await loadAllTasks(tasksDir);
  log(`Loaded ${allTasks.length} tasks (multi_session excluded)`);

  const selectedIds = selectTaskIds(allTasks, suite);
  const tasksToRun = selectedIds
    ? allTasks.filter((t) => selectedIds.includes(t.taskId))
    : allTasks;
  log(`Running ${tasksToRun.length} tasks (suite: ${suite})`);

  // We create one Gateway per task so each gets a fresh workspace as the
  // project root. This avoids file collisions between tasks.
  const taskEntries: TaskEntry[] = [];
  const grades = new Map<string, GradeResult>();

  for (let i = 0; i < tasksToRun.length; i++) {
    const task = tasksToRun[i];
    log(`\n${"=".repeat(80)}`);
    log(`Task ${i + 1}/${tasksToRun.length}: ${task.taskId} — ${task.name}`);
    log(`${"=".repeat(80)}`);

    let workspace: TaskWorkspace | undefined;
    try {
      workspace = await prepareTaskWorkspace(task, skillDir);

      const { gateway }: { gateway: Gateway } = createLocalGateway({
        projectRoot: workspace.cwd,
        permissionMode: "bypassPermissions",
      });

      const timeoutMs = task.timeoutSeconds * timeoutMultiplier * 1000;

      if (verbose) {
        log(`   Prompt: ${task.prompt.slice(0, 200)}...`);
        log(`   Timeout: ${timeoutMs / 1000}s`);
        log(`   Workspace: ${workspace.cwd}`);
      }

      const execResult = await executeTask(gateway, {
        taskId: task.taskId,
        prompt: task.prompt,
        timeoutMs,
      });

      log(`   Status: ${execResult.status} (${(execResult.executionTimeMs / 1000).toFixed(1)}s)`);
      log(`   Tokens: ${execResult.usage.totalTokens ?? 0} (in: ${execResult.usage.inputTokens ?? 0}, out: ${execResult.usage.outputTokens ?? 0})`);
      log(`   Tool calls: ${execResult.toolCalls.length}`);

      if (verbose && execResult.assistantText) {
        log(`   Response: ${execResult.assistantText.slice(0, 500)}...`);
      }

      // Grade
      const grade = await gradeTask(task, execResult, {
        skillDir,
        workspacePath: workspace.cwd,
        judgeModel,
        verbose,
      });
      grades.set(task.taskId, grade);

      const scorePct = grade.max_score > 0 ? (grade.score / grade.max_score) * 100 : 0;
      const icon = grade.score >= grade.max_score ? "[OK]" : grade.score > 0 ? "[--]" : "[!!]";
      log(`   ${icon} Score: ${grade.score.toFixed(2)}/${grade.max_score.toFixed(2)} (${scorePct.toFixed(0)}%) — ${grade.grading_type}`);
      if (grade.notes) log(`   Notes: ${grade.notes.slice(0, 200)}`);

      const usageDict: Record<string, number> = {
        input_tokens: execResult.usage.inputTokens ?? 0,
        output_tokens: execResult.usage.outputTokens ?? 0,
        cache_read_tokens: execResult.usage.cacheReadTokens ?? 0,
        cache_write_tokens: execResult.usage.cacheWriteTokens ?? 0,
        total_tokens: execResult.usage.totalTokens ?? 0,
        cost_usd: execResult.usage.nativeCost ?? 0,
        request_count: 1,
      };

      taskEntries.push({
        task_id: task.taskId,
        status: execResult.status,
        timed_out: execResult.status === "timeout",
        execution_time: execResult.executionTimeMs / 1000,
        transcript_length: execResult.events.length,
        usage: usageDict,
        workspace: workspace.cwd,
        grading: {
          runs: [grade],
          mean: grade.score,
          std: 0,
          min: grade.score,
          max: grade.score,
        },
        frontmatter: task.frontmatter,
      });

      // Router stats verbose output is currently disabled: the in-process
      // accessor was retired in the ui-server refactor (gateway is now
      // remote-capable and stats live in ~/.pilotdeck/router-stats.json,
      // owned by `TokenStatsCollector`). Re-wire from the persisted JSON
      // if benchmark verbose mode needs this back.
      void gateway;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`   [!!] Task error: ${message}`);
      grades.set(task.taskId, {
        task_id: task.taskId,
        score: 0,
        max_score: 1,
        grading_type: task.gradingType,
        breakdown: {},
        notes: `Runner error: ${message}`,
      });
      taskEntries.push({
        task_id: task.taskId,
        status: "error",
        timed_out: false,
        execution_time: 0,
        transcript_length: 0,
        usage: {},
        workspace: workspace?.cwd ?? "",
        grading: {
          runs: [],
          mean: 0,
          std: 0,
          min: 0,
          max: 0,
        },
        frontmatter: task.frontmatter,
      });
    } finally {
      await workspace?.cleanup().catch(() => {});
    }
  }

  // Summary
  printScoreSummary(taskEntries, tasksToRun, grades);

  const efficiency = computeEfficiency(taskEntries, grades);
  log(`\nToken Efficiency: ${efficiency.tokens_per_task.toFixed(0)} tok/task, ${efficiency.total_execution_time_seconds.toFixed(1)}s total`);
  if (efficiency.score_per_1k_tokens != null) {
    log(`   Score/1K tokens: ${efficiency.score_per_1k_tokens.toFixed(4)}`);
  }

  // Write results JSON (compatible with benchmark.py output)
  const runId = `pd-${Date.now()}`;
  const aggregate = {
    model: "pilotdeck",
    benchmark_version: getGitVersion(),
    run_id: runId,
    timestamp: Date.now() / 1000,
    suite,
    runs_per_task: 1,
    runner: "pilotdeck-gateway",
    tasks: taskEntries,
    efficiency,
  };

  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}.json`);
  await writeFile(outputPath, JSON.stringify(aggregate, null, 2), "utf-8");
  log(`\nResults saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
