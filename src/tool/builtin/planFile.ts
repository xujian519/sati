import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PILOT_PROJECT_DIR_NAME } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";

export type PlanFileManager = {
  getPlanFilePath(sessionId: string): string;
  ensurePlanFile(sessionId: string, title?: string): string;
  readPlan(sessionId: string): string | undefined;
};

/**
 * Slugify a plan title for use as a filename. Keeps CJK / latin characters,
 * collapses whitespace/punctuation into hyphens, and trims to 60 chars.
 */
function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
}

export function createPlanFileManager(options: {
  projectRoot: string;
}): PlanFileManager {
  const planDir = resolve(options.projectRoot, PILOT_PROJECT_DIR_NAME, "plans");

  // sessionId → absolute file path (populated on ensurePlanFile)
  const pathsBySession = new Map<string, string>();

  function getPlanFilePath(sessionId: string): string {
    const cached = pathsBySession.get(sessionId);
    if (cached) return cached;
    const safeId = sanitizeSessionIdForPath(sessionId);
    return resolve(planDir, `${safeId}.md`);
  }

  function ensurePlanFile(sessionId: string, title?: string): string {
    const cached = pathsBySession.get(sessionId);
    if (cached) return cached;

    mkdirSync(planDir, { recursive: true });

    const safeId = sanitizeSessionIdForPath(sessionId);
    let filePath: string;
    if (title) {
      const slug = slugifyTitle(title);
      const shortId = safeId.slice(0, 12);
      filePath = resolve(planDir, `${slug}-${shortId}.md`);
    } else {
      filePath = resolve(planDir, `${safeId}.md`);
    }

    if (!existsSync(filePath)) {
      writeFileSync(filePath, "", "utf8");
    }
    pathsBySession.set(sessionId, filePath);
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
