/**
 * Thin gateway proxy — knowledge capabilities live on the gateway side
 * (`InProcessGateway.knowledgeCapabilities`, wired from per-project runtime
 * knowledge paths + resolver stats in `createLocalGateway`). This file only
 * resolves display names to project roots and forwards to the
 * `knowledge_capabilities` protocol method (via `sati-bridge.js`).
 */

import { getSatiGateway } from "./sati-bridge.js";
import { extractProjectDirectory } from "./projects.js";

export async function getKnowledgeCapabilities(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getSatiGateway();
  if (typeof gw.knowledgeCapabilities !== "function") {
    const error = new Error("Knowledge capabilities is not available on this gateway");
    error.code = "not_configured";
    throw error;
  }
  const result = await gw.knowledgeCapabilities({ projectKey: projectRoot });
  if (result && result.error) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    throw error;
  }
  return result;
}
