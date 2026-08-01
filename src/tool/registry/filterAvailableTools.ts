import type { SatiToolAvailability, SatiToolAvailabilityContext, SatiToolDefinition } from "../protocol/types.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type SatiUnavailableToolDiagnostic = {
  toolName: string;
  code: Exclude<SatiToolAvailability, { ok: true }>["code"];
  reason: string;
};

export type FilterAvailableToolsResult = {
  registry: ToolRegistry;
  unavailable: SatiUnavailableToolDiagnostic[];
};

export async function filterAvailableTools(
  registry: ToolRegistry,
  context: SatiToolAvailabilityContext,
): Promise<FilterAvailableToolsResult> {
  const filtered = new ToolRegistry();
  const unavailable: SatiUnavailableToolDiagnostic[] = [];
  const checkCache = new Map<NonNullable<SatiToolDefinition["checkAvailability"]>, Promise<SatiToolAvailability>>();

  for (const tool of registry.list()) {
    const availability = await resolveToolAvailability(tool, context, checkCache);
    if (availability.ok) {
      filtered.register(tool);
      continue;
    }

    unavailable.push({
      toolName: tool.name,
      code: availability.code,
      reason: availability.reason,
    });
  }

  return { registry: filtered, unavailable };
}

async function resolveToolAvailability(
  tool: SatiToolDefinition,
  context: SatiToolAvailabilityContext,
  cache: Map<NonNullable<SatiToolDefinition["checkAvailability"]>, Promise<SatiToolAvailability>>,
): Promise<SatiToolAvailability> {
  const check = tool.checkAvailability;
  if (!check) {
    return { ok: true };
  }

  let promise = cache.get(check);
  if (!promise) {
    promise = Promise.resolve()
      .then(() => check(context))
      .catch(
        (error): SatiToolAvailability => ({
          ok: false,
          code: "failed_check",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    cache.set(check, promise);
  }

  return promise;
}
