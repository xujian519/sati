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
    classes.add(classifyPath(path));
  }

  return [...classes];
}

function classifyPath(path: string): PolitConfigChangeClass {
  if (path.startsWith("agent.") || path.startsWith("model.")) {
    return "next-request";
  }
  if (path === "extension.includeHookEvents") {
    return "runtime-live";
  }
  if (path.startsWith("extension.")) {
    return "next-runtime";
  }
  if (path.startsWith("router.")) {
    return classifyRouterPath(path);
  }
  if (path.startsWith("cron.")) {
    return "restart-required";
  }
  return "next-runtime";
}

function classifyRouterPath(path: string): PolitConfigChangeClass {
  if (
    path.startsWith("router.scenarios.") ||
    path.startsWith("router.fallback.") ||
    path.startsWith("router.tokenSaver.tiers.") ||
    path === "router.zeroUsageRetry.maxAttempts" ||
    path === "router.zeroUsageRetry.enabled"
  ) {
    return "next-request";
  }
  if (path.startsWith("router.tokenSaver.judge")) {
    return "runtime-live";
  }
  if (path === "router.autoOrchestrate.skillExtensionId") {
    return "next-runtime";
  }
  if (
    path === "router.stats.enabled" ||
    path === "router.customRouter.extensionId"
  ) {
    return "restart-required";
  }
  return "next-runtime";
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
