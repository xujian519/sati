import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBashTool,
  createGlobTool,
  createReadFileTool,
  ToolRuntime,
  ToolRegistry,
  type PilotDeckToolResult,
} from "../../src/tool/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import {
  dualParityExecutionScenarios,
  type DualParityExecutionReport,
  type DualParityExecutionScenario,
} from "../fixtures/tool/dual-parity/executionScenarios.js";
import { contentToText } from "../../src/tool/index.js";

export async function createPilotDeckExecutionReport(): Promise<DualParityExecutionReport[]> {
  const reports: DualParityExecutionReport[] = [];
  for (const scenario of dualParityExecutionScenarios) {
    if (scenario.status !== "compare") {
      reports.push({
        id: scenario.id,
        status: scenario.status,
        legacyToolName: scenario.legacy.toolName,
        pilotdeckToolName: scenario.pilotdeck.toolName,
        reason: scenario.reason,
      });
      continue;
    }

    const workspace = await createWorkspace(scenario.workspace);
    try {
      reports.push(await runScenario(scenario, workspace));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return reports;
}

async function runScenario(
  scenario: DualParityExecutionScenario,
  workspace: string,
): Promise<DualParityExecutionReport> {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createBashTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const result = await runtime.execute(
    { id: scenario.id, name: scenario.pilotdeck.toolName, input: scenario.pilotdeck.input },
    {
      sessionId: "dual-parity",
      turnId: "dual-parity",
      cwd: workspace,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: workspace,
        mode: "bypassPermissions",
      }),
      maxResultBytes: 100_000,
    },
  );

  return {
    id: scenario.id,
    status: scenario.status,
    legacyToolName: scenario.legacy.toolName,
    pilotdeckToolName: scenario.pilotdeck.toolName,
    result: normalizePilotDeckResult(result),
  };
}

function normalizePilotDeckResult(result: PilotDeckToolResult): NonNullable<DualParityExecutionReport["result"]> {
  if (result.type === "error") {
    return {
      status: "error",
      errorCode: result.error.code,
      text: result.content.map(contentToText).join("\n"),
    };
  }

  const normalized: NonNullable<DualParityExecutionReport["result"]> = {
    status: "success",
    text: result.content.map(contentToText).join("\n"),
  };
  const data = normalizeData(result.data);
  if (data) normalized.data = data;
  return normalized;
}

function normalizeData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if ("files" in record) {
    return { files: record.files };
  }
  if ("exitCode" in record) {
    return { exitCode: record.exitCode };
  }
  return undefined;
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-exec-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}
