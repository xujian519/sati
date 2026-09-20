import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import i18n from "./config.js";

const localeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const LANGUAGES = ["en", "zh-CN"] as const;

function localeNamespaces(language: string): string[] {
  return fs
    .readdirSync(path.join(localeRoot, language))
    .filter(file => file.endsWith(".json"))
    .map(file => file.replace(/\.json$/, ""))
    .sort();
}

function registeredNamespaces(language: string): string[] {
  const resources = (i18n.options.resources ?? {}) as Record<string, Record<string, unknown>>;
  return Object.keys(resources[language] ?? {}).sort();
}

/**
 * `config.js` registers resources by hand, so a locale file can exist on disk
 * while its namespace is never wired up — the UI then silently falls back to
 * English for that namespace.
 */
describe("i18n resource registration", () => {
  it.each(LANGUAGES)("registers every %s locale file", language => {
    expect(registeredNamespaces(language)).toEqual(localeNamespaces(language));
  });

  it("keeps en and zh-CN namespaces in parity", () => {
    expect(registeredNamespaces("zh-CN")).toEqual(registeredNamespaces("en"));
  });

  it("registers every namespace declared in `ns`", () => {
    const declared = [...((i18n.options.ns ?? []) as string[])].sort();
    for (const language of LANGUAGES) {
      expect(declared.filter(ns => !registeredNamespaces(language).includes(ns))).toEqual([]);
    }
  });
});
