/**
 * Worker registry for the workflow engine.
 *
 * Adapted from XiaoNuo Agent's `worker-resolver.ts`. A worker is a named
 * subagent definition (system prompt + allowed tools + model + failure
 * strategy) that steps reference by name.
 */

import type { WorkflowWorkerDefinition } from "../protocol/types.js";

/** Thrown when a step references an unregistered worker. */
export class WorkflowWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowWorkerError";
  }
}

export class WorkflowWorkerResolver {
  private readonly workers = new Map<string, WorkflowWorkerDefinition>();

  register(definition: WorkflowWorkerDefinition): void {
    if (this.workers.has(definition.name)) {
      throw new WorkflowWorkerError(`Worker "${definition.name}" is already registered`);
    }
    this.workers.set(definition.name, definition);
  }

  registerMany(definitions: WorkflowWorkerDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  resolve(name: string): WorkflowWorkerDefinition {
    const definition = this.workers.get(name);
    if (!definition) {
      throw new WorkflowWorkerError(`Worker "${name}" is not registered`);
    }
    return definition;
  }

  has(name: string): boolean {
    return this.workers.has(name);
  }

  list(): WorkflowWorkerDefinition[] {
    return [...this.workers.values()];
  }
}
