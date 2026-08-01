import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SatiConfig } from "../types";

export function safeParseYaml(text: string): SatiConfig | null {
  try {
    const value = parseYaml(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as SatiConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function configToYamlString(config: SatiConfig): string {
  return stringifyYaml(config, { indent: 2, lineWidth: 0 });
}
