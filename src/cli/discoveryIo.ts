/**
 * Core-host I/O adapters for `createDiscoveryPlanService`.
 *
 * Sourced entirely from core modules so the CLI server command can wire the
 * discovery-plan service without borrowing `ui/server` logic:
 *   - `extractProjectDirectory`: absolute-path passthrough + pilotHome
 *     fallback (the UI/bridge layer resolves display names before calling
 *     the gateway protocol methods);
 *   - `sessions`: `listProjectSessions` (core transcript listing);
 *   - `isSessionActive`: degraded to `false` — the authoritative live
 *     session state lives in the gateway/UI bridge layer;
 *   - run history: `AlwaysOnRunHistoryService`;
 *   - run logs: inline appends mirroring `ui/server` run-log semantics
 *     (candidate for a future shared storage module).
 */
import { isAbsolute, join, resolve } from "node:path";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { listProjectSessions } from "../session/index.js";
import type { DiscoveryPlanIo } from "../always-on/web/service-factory.js";
import { AlwaysOnRunHistoryService } from "../always-on/web/AlwaysOnRunHistoryService.js";
import { resolveAlwaysOnPaths } from "../always-on/storage/AlwaysOnPaths.js";

export type CreateCoreDiscoveryPlanIoOptions = {
  pilotHome: string;
  /** Optional display-name → directory resolver; defaults to absolute passthrough. */
  extractProjectDirectory?: (projectName: string) => Promise<string>;
};

function normalizeRunId(runId: string): string {
  return runId.trim().replace(/[^a-zA-Z0-9._:-]/g, "-");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Always-On root for a project under `<pilotHome>/always-on/projects/<id>`. */
function getAlwaysOnRoot(pilotHome: string, projectRoot: string): string {
  return resolveAlwaysOnPaths({ pilotHome, projectKey: projectRoot }).projectDir;
}

function getRunsDir(pilotHome: string, projectRoot: string): string {
  return join(getAlwaysOnRoot(pilotHome, projectRoot), "runs");
}

export function createCoreDiscoveryPlanIo(options: CreateCoreDiscoveryPlanIoOptions): DiscoveryPlanIo {
  const { pilotHome } = options;
  const runHistory = new AlwaysOnRunHistoryService({
    paths: {
      getAlwaysOnRoot: projectRoot => getAlwaysOnRoot(pilotHome, projectRoot),
    },
    logs: {
      getAlwaysOnRunLog: async (projectRoot, runId) => {
        const safeRunId = normalizeRunId(runId);
        const file = join(getRunsDir(pilotHome, projectRoot), `${safeRunId}.log`);
        try {
          const [content, fileStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
          return { content, truncated: false, updatedAt: fileStat.mtime.toISOString(), size: fileStat.size };
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return { content: "", truncated: false, size: 0 };
          }
          throw error;
        }
      },
    },
  });

  return {
    extractProjectDirectory: async projectName => {
      if (isAbsolute(projectName)) {
        return resolve(projectName);
      }
      if (options.extractProjectDirectory) {
        return options.extractProjectDirectory(projectName);
      }
      // Fallback: treat the name as a project directory under pilotHome.
      return resolve(pilotHome, "projects", projectName);
    },
    getSessions: async (projectName, limit, offset) => {
      const projectRoot = isAbsolute(projectName)
        ? resolve(projectName)
        : options.extractProjectDirectory
          ? await options.extractProjectDirectory(projectName)
          : resolve(pilotHome, "projects", projectName);
      const sessions = await listProjectSessions({
        projectRoot,
        pilotHome,
        limit: limit === Number.MAX_SAFE_INTEGER ? undefined : limit,
        offset: offset || undefined,
      });
      // Core `SessionInfo` uses `sessionId`; `DiscoveryPlanService` looks up
      // sessions by `id` — map it so execution-session matching works.
      return { sessions: sessions.map(session => ({ ...session, id: session.sessionId })) };
    },
    isSessionActive: () => false,
    appendRunEvent: (projectRoot, event) => runHistory.appendRunEvent(projectRoot, event),
    appendRunLog: async (projectRoot, runId, lines) => {
      const values = Array.isArray(lines) ? lines : [lines];
      const content = values
        .map(line => (typeof line === "string" ? line : String(line ?? "")))
        .filter(line => line.length > 0)
        .map(ensureTrailingNewline)
        .join("");
      if (!content) return;
      const safeRunId = normalizeRunId(runId);
      if (!safeRunId) return;
      await mkdir(getRunsDir(pilotHome, projectRoot), { recursive: true });
      await appendFile(join(getRunsDir(pilotHome, projectRoot), `${safeRunId}.log`), content, "utf8");
    },
    appendRunLogEvent: async (projectRoot, runId, event) => {
      const safeRunId = normalizeRunId(runId);
      if (!safeRunId) return;
      await mkdir(getRunsDir(pilotHome, projectRoot), { recursive: true });
      await appendFile(
        join(getRunsDir(pilotHome, projectRoot), `${safeRunId}.events.jsonl`),
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...event, runId })}\n`,
        "utf8",
      );
    },
    formatLogLine: ({ timestamp = new Date().toISOString(), level = "info", runId, planId, phase, message }) => {
      const safeMessage = String(message || "")
        .replace(/\s+/g, " ")
        .trim();
      return `[AlwaysOnPlanRun] ts=${timestamp} level=${level} runId=${runId} planId=${planId} phase=${phase} message=${JSON.stringify(safeMessage)}`;
    },
  };
}
