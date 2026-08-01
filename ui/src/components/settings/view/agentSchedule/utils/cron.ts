import type { SatiConfig } from "../../modelPool/types";

export function isCronConfigEnabled(config: SatiConfig): boolean {
  return config.cron !== undefined && config.cron.enabled !== false;
}
