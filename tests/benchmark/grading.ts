import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Task } from "./taskLoader.js";
import type { ExecutionResult } from "./executor.js";

const execFileAsync = promisify(execFile);

const BRIDGE_SCRIPT = new URL("grade_bridge.py", import.meta.url).pathname;

export type GradeResult = {
  task_id: string;
  score: number;
  max_score: number;
  grading_type: string;
  breakdown: Record<string, number>;
  notes: string;
};

/**
 * Convert PilotDeck GatewayEvent-based execution result into the shape
 * that PinchBench's Python `grade_task()` expects as `execution_result`.
 */
function toPythonExecutionResult(
  exec: ExecutionResult,
  workspacePath: string,
): Record<string, unknown> {
  const transcript = buildTranscriptFromEvents(exec);
  return {
    agent_id: "pilotdeck",
    task_id: exec.taskId,
    status: exec.status,
    transcript,
    usage: {
      input_tokens: exec.usage.inputTokens ?? 0,
      output_tokens: exec.usage.outputTokens ?? 0,
      cache_read_tokens: exec.usage.cacheReadTokens ?? 0,
      cache_write_tokens: exec.usage.cacheWriteTokens ?? 0,
      total_tokens: exec.usage.totalTokens ?? 0,
      cost_usd: exec.usage.nativeCost ?? 0,
      request_count: 1,
    },
    workspace: workspacePath,
    exit_code: exec.status === "success" ? 0 : 1,
    timed_out: exec.status === "timeout",
    execution_time: exec.executionTimeMs / 1000,
    stdout: exec.assistantText,
    stderr: exec.error ?? "",
  };
}

/**
 * Build a minimal PinchBench-compatible transcript from Gateway events.
 * The Python grading code inspects `type: "message"` entries with
 * `message.role == "assistant"` and `message.content` arrays.
 */
function buildTranscriptFromEvents(exec: ExecutionResult): unknown[] {
  const entries: unknown[] = [];

  if (exec.assistantText) {
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: exec.assistantText }],
      },
    });
  }

  for (const tc of exec.toolCalls) {
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: tc.name, arguments: {} }],
      },
    });
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        content: [tc.ok ? "success" : "error"],
      },
    });
  }

  return entries;
}

/**
 * Grade a task by calling the Python bridge script.
 * Returns the parsed GradeResult or a zero-score fallback on failure.
 */
export async function gradeTask(
  task: Task,
  exec: ExecutionResult,
  opts: {
    skillDir: string;
    workspacePath: string;
    judgeModel?: string;
    verbose?: boolean;
    pythonBin?: string;
  },
): Promise<GradeResult> {
  const inputPayload = {
    task_file: task.filePath,
    execution_result: toPythonExecutionResult(exec, opts.workspacePath),
    skill_dir: opts.skillDir,
    judge_model: opts.judgeModel,
    verbose: opts.verbose ?? false,
  };

  const tmpFile = path.join(os.tmpdir(), `pinchbench-grade-${task.taskId}-${Date.now()}.json`);
  await writeFile(tmpFile, JSON.stringify(inputPayload), "utf-8");

  try {
    const { stdout } = await execFileAsync(
      opts.pythonBin ?? "python3",
      [BRIDGE_SCRIPT, tmpFile],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
    );

    const result = JSON.parse(stdout.trim()) as GradeResult;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      task_id: task.taskId,
      score: 0,
      max_score: 1,
      grading_type: task.gradingType,
      breakdown: {},
      notes: `Grading bridge failed: ${message}`,
    };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
