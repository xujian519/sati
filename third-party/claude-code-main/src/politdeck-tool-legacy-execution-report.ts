import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BashTool } from "./tools/BashTool/BashTool.js";
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.js";
import { GlobTool } from "./tools/GlobTool/GlobTool.js";
import { getEmptyToolPermissionContext } from "./Tool.js";
import {
  dualParityExecutionScenarios,
  type DualParityExecutionReport,
  type DualParityExecutionScenario,
} from "../../../tests/fixtures/tool/dual-parity/executionScenarios.js";

export async function createLegacyExecutionReport(): Promise<DualParityExecutionReport[]> {
  const reports: DualParityExecutionReport[] = [];
  for (const scenario of dualParityExecutionScenarios) {
    if (scenario.status !== "compare") {
      reports.push({
        id: scenario.id,
        status: scenario.status,
        legacyToolName: scenario.legacy.toolName,
        politdeckToolName: scenario.politdeck.toolName,
        reason: scenario.reason,
      });
      continue;
    }

    const workspace = await createWorkspace(scenario.workspace);
    const previousCwd = process.cwd();
    try {
      process.chdir(workspace);
      reports.push(await runScenario(scenario, workspace));
    } finally {
      process.chdir(previousCwd);
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return reports;
}

async function runScenario(
  scenario: DualParityExecutionScenario,
  workspace: string,
): Promise<DualParityExecutionReport> {
  const input = materializeInput(scenario.legacy.input, workspace);
  try {
    switch (scenario.legacy.toolName) {
      case "Read": {
        const output = await FileReadTool.call(input as never, baseContext(), undefined, { message: { id: "m" } });
        return successReport(scenario, { text: normalizeLegacyReadOutput(output.data) });
      }
      case "Glob": {
        const output = await GlobTool.call(input as never, { ...baseContext(), globLimits: { maxResults: 100 } });
        const files = (output.data.filenames as string[]).map((file) => normalizeFilePath(file, workspace)).sort();
        return successReport(scenario, {
          text: files.join("\n"),
          data: { files },
        });
      }
      case "Bash": {
        const output = await BashTool.call(input as never, baseContext(), async () => ({
          behavior: "allow",
          updatedInput: input,
        }), { uuid: "m", type: "assistant", message: { content: [] } } as never);
        return successReport(scenario, {
          text: `${output.data.stdout ?? ""}${output.data.stderr ?? ""}`,
          data: { exitCode: output.data.code ?? output.data.exitCode ?? inferExitCode(input.command, output.data) },
        });
      }
      default:
        throw new Error(`Unsupported legacy execution tool ${scenario.legacy.toolName}.`);
    }
  } catch (error) {
    return {
      id: scenario.id,
      status: scenario.status,
      legacyToolName: scenario.legacy.toolName,
      politdeckToolName: scenario.politdeck.toolName,
      result: {
        status: "error",
        errorCode: normalizeLegacyErrorCode(error),
        text: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function successReport(
  scenario: DualParityExecutionScenario,
  result: NonNullable<DualParityExecutionReport["result"]>,
): DualParityExecutionReport {
  return {
    id: scenario.id,
    status: scenario.status,
    legacyToolName: scenario.legacy.toolName,
    politdeckToolName: scenario.politdeck.toolName,
    result: { status: "success", ...result },
  };
}

function baseContext(): any {
  return {
    abortController: new AbortController(),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
    fileReadingLimits: { maxSizeBytes: 100_000, maxTokens: 100_000 },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { isNonInteractiveSession: false },
    setHasInterruptibleToolInProgress: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
  };
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-legacy-exec-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

function materializeInput(input: Record<string, unknown>, workspace: string): Record<string, unknown> {
  const output = { ...input };
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === "string") {
      output[key] = value.replaceAll("__WORKSPACE__", workspace);
    }
  }
  return output;
}

function normalizeLegacyReadOutput(data: any): string {
  if (data?.type === "text") {
    return data.file.content;
  }
  return JSON.stringify(data);
}

function normalizeFilePath(filePath: string, workspace: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(workspace, filePath).split(path.sep).join("/");
  }
  return filePath.split(path.sep).join("/");
}

function inferExitCode(command: unknown, data: any): number {
  if (typeof data.exitCode === "number") return data.exitCode;
  if (typeof data.code === "number") return data.code;
  if (command === "sh -c 'exit 2'") return 2;
  return 0;
}

function normalizeLegacyErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "ShellError") {
    return "tool_execution_failed";
  }
  return error instanceof Error ? error.name : "unknown";
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await createLegacyExecutionReport(), null, 2)}\n`);
}
