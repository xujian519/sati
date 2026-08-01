/**
 * Step-input template resolver.
 *
 * Adapted from XiaoNuo Agent's `input-resolver.ts`. Resolves `{{path}}`
 * placeholders in a step's input template against the accumulated step
 * outputs. Alias references (e.g. `{ previous: "step1.output.summary" }`) are
 * resolved first, then direct paths.
 */

import type { WorkflowStepOutput } from "../protocol/types.js";

export type WorkflowStepOutputs = Record<string, { status: string; output?: WorkflowStepOutput }>;

/** Thrown when a template references a missing path. */
export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

function lookup(path: string, stepOutputs: WorkflowStepOutputs, planContext: Record<string, unknown>): unknown {
  const segments = path.split(".");
  if (segments.length === 0) return undefined;
  // Plan-level context references (e.g. `context.goal`) use a `context.` prefix.
  if (segments[0] === "context") {
    let current: unknown = planContext;
    for (const segment of segments.slice(1)) {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
  // Step references: `stepId.status`, `stepId.output.summary`,
  // `stepId.output.data.field`, `stepId.output.artifacts`.
  const stepId = segments[0]!;
  const entry = stepOutputs[stepId];
  if (!entry) return undefined;
  if (segments.length === 1) return entry;
  if (segments[1] === "status") return entry.status;
  if (segments[1] === "output" && entry.output) {
    const rest = segments.slice(2);
    let current: unknown = entry.output;
    for (const segment of rest) {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolve a step input template to concrete text.
 *
 * @param template Template with `{{path}}` placeholders.
 * @param references Alias map resolved before direct paths.
 * @param stepOutputs Accumulated step outputs keyed by step id.
 * @param planContext Plan-level context (`context.*` references).
 * @throws {@link WorkflowInputError} when a referenced path cannot be resolved.
 */
export function resolveInputTemplate(
  template: string,
  references: Record<string, string> | undefined,
  stepOutputs: WorkflowStepOutputs,
  planContext: Record<string, unknown>,
): string {
  // First pass: alias references.
  let resolved = template;
  if (references) {
    for (const [alias, path] of Object.entries(references)) {
      const placeholder = `{{${alias}}}`;
      if (resolved.includes(placeholder)) {
        const value = lookup(path, stepOutputs, planContext);
        if (value === undefined) {
          throw new WorkflowInputError(`Reference "${alias}" -> "${path}" did not resolve`);
        }
        resolved = resolved.split(placeholder).join(formatValue(value));
      }
    }
  }
  // Second pass: direct paths.
  const direct = resolved.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = lookup(path.trim(), stepOutputs, planContext);
    if (value === undefined) {
      throw new WorkflowInputError(`Template path "{{${path}}}" did not resolve`);
    }
    return formatValue(value);
  });
  return direct;
}
