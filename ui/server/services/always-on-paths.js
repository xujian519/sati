import path from "path";
import { resolvePilotHome, resolveProjectStorageId } from "../utils/pilotPaths.js";

export function getAlwaysOnRoot(projectRoot) {
  const pilotHome = resolvePilotHome();
  const projectId = resolveProjectStorageId(path.resolve(projectRoot), pilotHome);
  return path.join(pilotHome, "always-on", "projects", projectId);
}
