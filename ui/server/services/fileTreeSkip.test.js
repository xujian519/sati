/**
 * `shouldSkipEntry` — the file-tree walk's skip predicate (#533).
 *
 * The debt was that the eager project file-tree walk traversed `.pnpm-store`,
 * which held 52,639 of 59,297 measured nodes (88.8%). Skipping it drops the
 * first-paint walk from ~621ms to ~67ms. These tests pin the predicate directly
 * (it is exported, so we test the real function, not a copy).
 *
 * The negative control matters: without `.pnpm-store` in the skip set the
 * "skips .pnpm-store" case goes red — that is the regression this issue is about.
 *
 * Imported from the dependency-free leaf module `fileTreeSkip.js` (not
 * `filesystem.js`, whose transitive chain reaches `src/patent/...` and does not
 * load under vitest/jsdom).
 */
import { describe, expect, it } from "vitest";
import { shouldSkipEntry } from "./fileTreeSkip.js";

describe("shouldSkipEntry", () => {
  it("skips .pnpm-store (the #533 regression: 88.8% of walked nodes)", () => {
    expect(shouldSkipEntry(".pnpm-store")).toBe(true);
  });

  it("skips the previously-handled heavy build and VCS directories", () => {
    for (const name of ["node_modules", "dist", "build", ".tmp", ".git", ".svn", ".hg"]) {
      expect(shouldSkipEntry(name), name).toBe(true);
    }
  });

  it("skips .sati* working directories and .sati_build bundles", () => {
    expect(shouldSkipEntry(".sati")).toBe(true);
    expect(shouldSkipEntry(".sati-cache")).toBe(true);
    expect(shouldSkipEntry(".sati_build.js")).toBe(true);
    expect(shouldSkipEntry(".sati_build.cjs")).toBe(true);
    expect(shouldSkipEntry(".sati_build.mjs")).toBe(true);
    // Case-insensitive parity with the original inline regex.
    expect(shouldSkipEntry(".SATI_BUILD.MJS")).toBe(true);
  });

  it("skips other dot-prefixed package-manager / build caches via the general rule", () => {
    for (const name of [".yarn", ".cargo", ".pnpm", ".npm", ".gradle", ".m2", ".venv", ".tox", "__pycache__"]) {
      expect(shouldSkipEntry(name), name).toBe(true);
    }
  });

  it("does NOT skip real project directories and files", () => {
    for (const name of ["src", "ui", "tests", "docs", "package.json", "README.md", "dist-lib", "builder", "gitea"]) {
      expect(shouldSkipEntry(name), name).toBe(false);
    }
  });

  it("does not over-match names that merely start with a skipped prefix", () => {
    // ".gitignore" is a file, not the ".git" directory — must be kept.
    expect(shouldSkipEntry(".gitignore")).toBe(false);
    expect(shouldSkipEntry(".github")).toBe(false);
    // "node_modules_backup" is not "node_modules".
    expect(shouldSkipEntry("node_modules_backup")).toBe(false);
  });
});
