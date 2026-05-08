import type { PolitDeckMarketplaceReference } from "./manifest.js";

export type PolitDeckPluginMarketplaceStatus = "resolved" | "deferred";

export type PolitDeckMarketplaceResolution = {
  status: PolitDeckPluginMarketplaceStatus;
  reference: PolitDeckMarketplaceReference;
  reason?: string;
};

export function resolveMarketplaceReference(reference: PolitDeckMarketplaceReference): PolitDeckMarketplaceResolution {
  if (reference.source === "git" || reference.source === "zip" || reference.source === "mcpb") {
    return {
      status: "deferred",
      reference,
      reason: `${reference.source} installation is not implemented in the local runtime.`,
    };
  }
  return { status: "resolved", reference };
}
