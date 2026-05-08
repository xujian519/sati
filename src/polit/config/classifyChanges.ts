import type { PolitConfigChangeClass, PolitConfigSnapshot } from "./types.js";

export function diffConfigSnapshots(
  previous: PolitConfigSnapshot,
  next: PolitConfigSnapshot,
): string[] {
  return diffValues(previous.config, next.config);
}

export function classifyConfigChanges(changedPaths: string[]): PolitConfigChangeClass[] {
  const classes = new Set<PolitConfigChangeClass>();

  for (const path of changedPaths) {
    if (path.startsWith("agent.") || path.startsWith("model.")) {
      classes.add("next-request");
    } else if (path === "extension.includeHookEvents") {
      classes.add("runtime-live");
    } else if (path.startsWith("extension.")) {
      classes.add("next-runtime");
    } else {
      classes.add("next-runtime");
    }
  }

  return [...classes];
}

function diffValues(left: unknown, right: unknown, prefix = ""): string[] {
  if (Object.is(left, right)) {
    return [];
  }

  if (!isDiffableObject(left) || !isDiffableObject(right)) {
    return [prefix || "<root>"];
  }

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    changes.push(...diffValues(left[key], right[key], path));
  }
  return changes;
}

function isDiffableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
