/**
 * `memory_*` builtin tools — agent-facing surface for the EdgeClaw memory
 * kernel (edgeclaw-memory-core). The `EdgeClawMemoryService` instance is
 * injected once at registry construction (closure capture), because
 * `SatiToolRuntimeContext` does not carry gateway-level services.
 *
 *   - memory_overview → `service.overview()` (status / freshness / backlog)
 *   - memory_list     → `service.list()` (browse memory manifest entries)
 *   - memory_search   → `service.search()` (explicit retrieval query)
 *   - memory_get      → `service.get()` (read exact memory file records)
 *   - memory_flush    → `service.flush()` (extract recent sessions now)
 *   - memory_dream    → `service.dream()` (cleanup / merge / manifest repair)
 *
 * overview/list/search/get are read-only and concurrency-safe; flush/dream
 * mutate the memory store and are therefore not marked read-only.
 */

import type { EdgeClawMemoryService, MemoryRecordType } from "edgeclaw-memory-core";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../protocol/types.js";

export type MemoryOverviewInput = Record<string, never>;
export type MemoryOverviewOutput = ReturnType<EdgeClawMemoryService["overview"]>;

export type MemoryListInput = {
  kinds?: MemoryRecordType[];
  query?: string;
  limit?: number;
  scope?: "global" | "project";
};
export type MemoryListOutput = ReturnType<EdgeClawMemoryService["list"]>;

export type MemorySearchInput = {
  query: string;
};
export type MemorySearchOutput = Awaited<ReturnType<EdgeClawMemoryService["search"]>>;

export type MemoryGetInput = {
  ids: string[];
  maxLines?: number;
};
export type MemoryGetOutput = ReturnType<EdgeClawMemoryService["get"]>;

export type MemoryFlushInput = {
  batchSize?: number;
};
export type MemoryFlushOutput = Awaited<ReturnType<EdgeClawMemoryService["flush"]>>;

export type MemoryDreamInput = Record<string, never>;
export type MemoryDreamOutput = Awaited<ReturnType<EdgeClawMemoryService["dream"]>>;

/** Wrap service failures as tool errors so the agent loop sees a clean failure instead of a crash. */
async function runServiceCall<T>(toolName: string, call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SatiToolRuntimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SatiToolRuntimeError("tool_execution_failed", `${toolName} failed: ${message}`);
  }
}

function jsonOutput<T>(value: T): SatiToolExecutionOutput<T> {
  return {
    content: [{ type: "json", value }],
    data: value,
  };
}

export function createMemoryOverviewTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemoryOverviewInput, MemoryOverviewOutput> {
  return {
    name: "memory_overview",
    title: "Memory Overview",
    description:
      "Return the ClawXMemory status overview: memory freshness, indexing backlog, last flush/dream timestamps, and runtime health. Use this for questions about memory state before drilling into specific records.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => jsonOutput(await runServiceCall("memory_overview", () => service.overview())),
  };
}

export function createMemoryListTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemoryListInput, MemoryListOutput> {
  return {
    name: "memory_list",
    title: "Memory List",
    description:
      "Browse file-based user, feedback, and project memory manifest entries. Optionally filter by kind, free-text query, scope, and limit.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kinds: {
          type: "array",
          items: { type: "string", enum: ["user", "feedback", "project", "general_project_meta"] },
          description: "Restrict to these memory record kinds.",
        },
        query: {
          type: "string",
          description: "Free-text filter over memory entry names and descriptions.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of entries to return.",
        },
        scope: {
          type: "string",
          enum: ["global", "project"],
          description: "Restrict to global or project-scoped memory.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input =>
      jsonOutput(
        await runServiceCall("memory_list", () =>
          service.list({
            kinds: input.kinds,
            query: input.query,
            limit: input.limit,
            scope: input.scope,
          }),
        ),
      ),
  };
}

export function createMemorySearchTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemorySearchInput, MemorySearchOutput> {
  return {
    name: "memory_search",
    title: "Memory Search",
    description:
      "Search durable long-term memory (preferences, collaboration rules, project progress across sessions). Run this before answering questions that may depend on earlier sessions, then use memory_get only for the exact file ids you need to verify.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query over long-term memory.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => jsonOutput(await runServiceCall("memory_search", () => service.search(input.query))),
  };
}

export function createMemoryGetTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemoryGetInput, MemoryGetOutput> {
  return {
    name: "memory_get",
    title: "Memory Get",
    description:
      "Read the exact memory file records for the given ids (returned by memory_list or memory_search). Use only for the specific files you need to verify.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["ids"],
      additionalProperties: false,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Memory file ids / relative paths to read.",
        },
        maxLines: {
          type: "integer",
          description: "Maximum content lines per record. Defaults to 80.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input =>
      jsonOutput(await runServiceCall("memory_get", () => service.get(input.ids, input.maxLines))),
  };
}

export function createMemoryFlushTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemoryFlushInput, MemoryFlushOutput> {
  return {
    name: "memory_flush",
    title: "Memory Flush",
    description:
      "Extract memory from recent sessions now. Use when the user asks why a just-finished conversation is not visible in memory yet, or explicitly wants recent memory extracted immediately.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        batchSize: {
          type: "integer",
          description: "Maximum number of pending sessions to process in this flush.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async input =>
      jsonOutput(
        await runServiceCall("memory_flush", () =>
          service.flush({ reason: "manual", ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}) }),
        ),
      ),
  };
}

export function createMemoryDreamTool(
  service: EdgeClawMemoryService,
): SatiToolDefinition<MemoryDreamInput, MemoryDreamOutput> {
  return {
    name: "memory_dream",
    title: "Memory Dream",
    description:
      "Run memory maintenance: cleanup, duplicate merge, and manifest repair. Use when the user asks for memory cleanup or consolidation.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => jsonOutput(await runServiceCall("memory_dream", () => service.dream("manual"))),
  };
}
