import {
  createAskUserQuestionTool,
  createBashTool,
  createEditFileTool,
  createEditNotebookTool,
  createGlobTool,
  createGrepTool,
  createListMcpResourcesTool,
  createMcpTool,
  createReadFileTool,
  createReadMcpResourceTool,
  createEnterPlanModeTool,
  createStructuredOutputTool,
  createTodoWriteTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  type PilotDeckToolDefinition,
} from "../../src/tool/index.js";
import {
  dualParityContractScenarios,
  type DualParityContractReport,
  type DualParityContractScenario,
} from "../fixtures/tool/dual-parity/contractScenarios.js";

export function createPilotDeckContractReport(): DualParityContractReport[] {
  const tools = new Map<string, PilotDeckToolDefinition>(
    [
      createReadFileTool(),
      createGlobTool(),
      createGrepTool(),
      createEditFileTool(),
      createEditNotebookTool(),
      createWriteFileTool(),
      createBashTool({
        runner: {
          run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
        },
      }),
      createAskUserQuestionTool(),
      createWebFetchTool(),
      createWebSearchTool(),
      createListMcpResourcesTool(),
      createReadMcpResourceTool(),
      createEnterPlanModeTool(),
      createStructuredOutputTool(),
      createTodoWriteTool(),
      createMcpTool({ serverId: "server", toolName: "tool" }),
    ].map((tool) => [tool.name, tool]),
  );

  return dualParityContractScenarios.map((scenario) => {
    if (scenario.status !== "compare") {
      return {
        id: scenario.id,
        status: scenario.status,
        legacyToolName: scenario.legacy.toolName,
        pilotdeckToolName: scenario.pilotdeck.toolName,
        reason: scenario.reason,
      };
    }

    const tool = tools.get(scenario.pilotdeck.toolName);
    if (!tool) {
      throw new Error(`Missing PilotDeck tool ${scenario.pilotdeck.toolName} for ${scenario.id}.`);
    }

    return {
      id: scenario.id,
      status: scenario.status,
      legacyToolName: scenario.legacy.toolName,
      pilotdeckToolName: scenario.pilotdeck.toolName,
      values: collectValues(tool, scenario.pilotdeck.input, scenario.compareFields),
    };
  });
}

function collectValues(
  tool: PilotDeckToolDefinition,
  input: Record<string, unknown>,
  fields: DualParityContractScenario["compareFields"],
): NonNullable<DualParityContractReport["values"]> {
  const values: NonNullable<DualParityContractReport["values"]> = {};
  for (const field of fields) {
    switch (field) {
      case "readOnly":
        values.readOnly = tool.isReadOnly(input);
        break;
      case "concurrencySafe":
        values.concurrencySafe = tool.isConcurrencySafe(input);
        break;
      case "openWorld":
        values.openWorld = tool.isOpenWorld?.(input) ?? false;
        break;
      case "destructive":
        values.destructive = tool.isDestructive?.(input) ?? false;
        break;
      case "requiresUserInteraction":
        values.requiresUserInteraction = tool.requiresUserInteraction?.(input) ?? false;
        break;
    }
  }
  return values;
}
