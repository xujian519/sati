import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getPilotProjectPlanDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";

export type PlanFileManager = {
  getPlanFilePath(sessionId: string): string;
  ensurePlanFile(sessionId: string): string;
  readPlan(sessionId: string): string | undefined;
};

export function createPlanFileManager(options: {
  pilotHome: string;
  projectRoot: string;
}): PlanFileManager {
  const planDir = getPilotProjectPlanDir(options.projectRoot, options.pilotHome);

  function getPlanFilePath(sessionId: string): string {
    const safeId = sanitizeSessionIdForPath(sessionId);
    return resolve(planDir, `${safeId}.md`);
  }

  function ensurePlanFile(sessionId: string): string {
    const filePath = getPlanFilePath(sessionId);
    mkdirSync(planDir, { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "", "utf8");
    }
    return filePath;
  }

  function readPlan(sessionId: string): string | undefined {
    const filePath = getPlanFilePath(sessionId);
    try {
      const content = readFileSync(filePath, "utf8");
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return { getPlanFilePath, ensurePlanFile, readPlan };
}
