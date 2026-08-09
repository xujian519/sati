import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolvePilotHome, resolveProjectStorageId } from "../utils/pilotPaths.js";
import { getSatiGateway } from "../sati-bridge.js";

/**
 * Read phase events from a single project's events.jsonl.
 *
 * @param {string} projectDir Absolute path to the project's always-on dir
 *   (e.g. `~/.sati/always-on/projects/<id>`)
 * @returns {Array<object>}
 */
async function readProjectEvents(projectDir) {
  const eventsFile = resolve(projectDir, "events.jsonl");
  let raw;
  try {
    raw = await readFile(eventsFile, "utf-8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return events;
}

/**
 * Build a lookup from projectKey -> { projectName, projectDisplayName }.
 */
async function buildProjectLookup(pilotHome) {
  const gateway = await getSatiGateway();
  const { projects } = await gateway.listProjects();
  const lookup = new Map();
  for (const project of projects) {
    const key = resolve(project.projectKey ?? project.fullPath ?? "");
    if (!key) continue;
    const name = resolveProjectStorageId(key, pilotHome);
    const displayName = project.displayName || key.split(/[\\/]/).pop() || name;
    lookup.set(key, { projectName: name, projectDisplayName: displayName });
  }
  return lookup;
}

/**
 * Aggregate Always-On phase events across all projects.
 *
 * 结果带 TTL 缓存（默认 15s，覆盖前端轮询间隔）：前端 AlwaysOnDashboard /
 * MainAreaV2 徽章按 15s 轮询调用，此前每次全量 readdir + 读取所有项目
 * events.jsonl + 逐行 parse + 全量 sort，随事件文件增长线性放大。缓存按
 * limit 分键，不同 limit 的请求不会互相错取。传入 `since`（增量 catch-up）
 * 时绕过缓存，避免增量语义错乱。
 *
 * @param {{ limit?: number; since?: string }} [opts]
 * @returns {Promise<{ events: Array<object> }>}
 */
const DASHBOARD_EVENTS_CACHE_TTL_MS = 15_000;
let dashboardEventsCache = { at: 0, limit: 0, data: null };

export async function getAlwaysOnDashboardEvents(opts = {}) {
  const { limit = 200, since } = opts;
  const nowMs = Date.now();
  if (
    !since &&
    dashboardEventsCache.data &&
    dashboardEventsCache.limit === limit &&
    nowMs - dashboardEventsCache.at < DASHBOARD_EVENTS_CACHE_TTL_MS
  ) {
    return dashboardEventsCache.data;
  }

  const pilotHome = resolvePilotHome();
  const projectsDir = resolve(pilotHome, "always-on", "projects");

  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { events: [] };
  }

  const lookup = await buildProjectLookup(pilotHome).catch(() => new Map());

  const allEvents = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(projectsDir, entry.name);
    const events = await readProjectEvents(dir);
    allEvents.push(...events);
  }

  let filtered = allEvents;

  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      filtered = filtered.filter(e => Date.parse(e.timestamp) >= sinceMs);
    }
  }

  filtered.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  if (limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  const events = filtered.map(event => {
    const key = resolve(event.projectKey || "");
    const info = lookup.get(key) || {
      projectName: resolveProjectStorageId(key || "unknown", pilotHome),
      projectDisplayName: key.split(/[\\/]/).pop() || "Unknown",
    };
    return {
      ...event,
      projectName: info.projectName,
      projectDisplayName: info.projectDisplayName,
    };
  });

  const result = { events };
  if (!since) {
    dashboardEventsCache = { at: nowMs, limit, data: result };
  }
  return result;
}
