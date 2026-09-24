/**
 * Pure skip predicate for the project file-tree walk (#533).
 *
 * Kept in its own dependency-free leaf module so it can be unit-tested directly
 * without importing `filesystem.js` (whose transitive chain reaches `routes/
 * projects.js` → `src/patent/...` and does not load under the UI vitest/jsdom
 * environment). No imports here on purpose.
 *
 * The debt: the eager file-tree walk traversed `.pnpm-store`, which held 52,639
 * of 59,297 measured nodes (88.8%). Skipping it drops the first-paint walk from
 * ~621ms to ~67ms. The dot-prefixed package-manager/build-cache rule generalizes
 * it so `.yarn` / `.cargo` / `__pycache__`-style caches don't each need their own
 * re-fix later.
 */

/** Directory names excluded from the eager project file-tree walk. */
const SKIP_TREE_ENTRIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".tmp",
  ".git",
  ".svn",
  ".hg",
  ".pnpm-store",
  "__pycache__",
]);

/** Dot-prefixed package-manager / build-tool cache directories (#533). */
const PKG_CACHE_DIR_RE = /^\.(yarn|cargo|pnpm|npm|gradle|m2|venv|tox|mypy_cache|pytest_cache|ruff_cache)\b/i;

/** `.sati_build.{js,cjs,mjs}` bundles (case-insensitive; parity with the original inline regex). */
const SATI_BUILD_BUNDLE_RE = /^\.sati_build\.(?:c|m)?js$/i;

/**
 * Decide whether a single file-tree entry name should be skipped.
 * Preserves the previous inline behaviour exactly and adds `.pnpm-store` plus
 * the general package-cache rule.
 *
 * @param {string} name entry name (basename, not a full path)
 * @returns {boolean} true when the entry must be excluded from the walk
 */
export function shouldSkipEntry(name) {
  if (SKIP_TREE_ENTRIES.has(name)) return true;
  // .sati* working directories (e.g. .sati, .sati-cache).
  if (name.startsWith(".sati")) return true;
  if (SATI_BUILD_BUNDLE_RE.test(name)) return true;
  if (PKG_CACHE_DIR_RE.test(name)) return true;
  return false;
}
