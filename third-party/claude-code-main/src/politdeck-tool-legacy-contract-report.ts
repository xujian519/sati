import path from "node:path";
import { AskUserQuestionTool } from "./tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { BashTool } from "./tools/BashTool/BashTool.js";
import { FileEditTool } from "./tools/FileEditTool/FileEditTool.js";
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { GlobTool } from "./tools/GlobTool/GlobTool.js";
import { GrepTool } from "./tools/GrepTool/GrepTool.js";
import { EnterPlanModeTool } from "./tools/EnterPlanModeTool/EnterPlanModeTool.js";
import { ListMcpResourcesTool } from "./tools/ListMcpResourcesTool/ListMcpResourcesTool.js";
import { MCPTool } from "./tools/MCPTool/MCPTool.js";
import { ReadMcpResourceTool } from "./tools/ReadMcpResourceTool/ReadMcpResourceTool.js";
import { WebFetchTool } from "./tools/WebFetchTool/WebFetchTool.js";
import { WebSearchTool } from "./tools/WebSearchTool/WebSearchTool.js";
import { SyntheticOutputTool } from "./tools/SyntheticOutputTool/SyntheticOutputTool.js";
import {
  dualParityContractScenarios,
  type DualParityContractReport,
  type DualParityContractScenario,
} from "../../../tests/fixtures/tool/dual-parity/contractScenarios.js";

type LegacyToolProbe = {
  name: string;
  isReadOnly?(input: Record<string, unknown>): boolean;
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
  isOpenWorld?(input: Record<string, unknown>): boolean;
  isDestructive?(input: Record<string, unknown>): boolean;
  requiresUserInteraction?(): boolean;
};

const legacyTools = new Map<string, LegacyToolProbe>(
  [
    FileReadTool,
    GlobTool,
    GrepTool,
    FileEditTool,
    FileWriteTool,
    BashTool,
    AskUserQuestionTool,
    WebFetchTool,
    WebSearchTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    EnterPlanModeTool,
    MCPTool,
    SyntheticOutputTool,
  ].map((tool) => [tool.name, tool]),
);

export function createLegacyContractReport(): DualParityContractReport[] {
  return dualParityContractScenarios.map((scenario) => {
    if (scenario.status !== "compare") {
      return {
        id: scenario.id,
        status: scenario.status,
        legacyToolName: scenario.legacy.toolName,
        politdeckToolName: scenario.politdeck.toolName,
        reason: scenario.reason,
      };
    }

    const tool = legacyTools.get(scenario.legacy.toolName);
    if (!tool) {
      throw new Error(`Missing legacy tool ${scenario.legacy.toolName} for ${scenario.id}.`);
    }

    const input = materializeLegacyInput(scenario);
    return {
      id: scenario.id,
      status: scenario.status,
      legacyToolName: scenario.legacy.toolName,
      politdeckToolName: scenario.politdeck.toolName,
      values: collectValues(tool, input, scenario.compareFields),
    };
  });
}

function collectValues(
  tool: LegacyToolProbe,
  input: Record<string, unknown>,
  fields: DualParityContractScenario["compareFields"],
): NonNullable<DualParityContractReport["values"]> {
  const values: NonNullable<DualParityContractReport["values"]> = {};
  for (const field of fields) {
    switch (field) {
      case "readOnly":
        values.readOnly = tool.isReadOnly?.(input) ?? false;
        break;
      case "concurrencySafe":
        values.concurrencySafe = tool.isConcurrencySafe?.(input) ?? false;
        break;
      case "openWorld":
        values.openWorld = tool.isOpenWorld?.(input) ?? false;
        break;
      case "destructive":
        values.destructive = tool.isDestructive?.(input) ?? false;
        break;
      case "requiresUserInteraction":
        values.requiresUserInteraction = tool.requiresUserInteraction?.() ?? false;
        break;
    }
  }
  return values;
}

function materializeLegacyInput(scenario: DualParityContractScenario): Record<string, unknown> {
  const input = { ...scenario.legacy.input };
  for (const [key, value] of Object.entries(input)) {
    if (value === "__ABS_PACKAGE_JSON__") {
      input[key] = path.join(process.cwd(), "package.json");
    }
    if (value === "__ABS_EDIT_FILE__") {
      input[key] = path.join(process.cwd(), "edit.txt");
    }
    if (value === "__ABS_WRITE_FILE__") {
      input[key] = path.join(process.cwd(), "write.txt");
    }
  }
  return input;
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(createLegacyContractReport(), null, 2)}\n`);
}
