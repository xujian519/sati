import type { SatiMarketplaceReference } from "./manifest.js";

export type SatiPluginMarketplaceStatus = "resolved" | "deferred";

export type SatiMarketplaceResolution = {
  status: SatiPluginMarketplaceStatus;
  reference: SatiMarketplaceReference;
  reason?: string;
};

export function resolveMarketplaceReference(reference: SatiMarketplaceReference): SatiMarketplaceResolution {
  if (reference.source === "git" || reference.source === "zip" || reference.source === "mcpb") {
    return {
      status: "deferred",
      reference,
      reason: `${reference.source} installation is not implemented in the local runtime.`,
    };
  }
  return { status: "resolved", reference };
}
