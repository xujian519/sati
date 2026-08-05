#!/usr/bin/env node
/**
 * Bump the application version in lockstep across the repo.
 *
 * Usage:
 *   node scripts/bump-version.mjs <patch|minor|major> [--root <dir>]
 *
 * Updates exactly three package.json files to the same new version:
 *   - <root>/package.json           (sati — read at runtime via src/version.ts)
 *   - <root>/apps/desktop/package.json  (@sati/desktop — release source of truth)
 *   - <root>/ui/package.json        (sati-ui)
 *
 * Pre-flight: the three versions must already be in lockstep, otherwise the
 * script refuses to run (release.sh enforces the same invariant at build time).
 * git commit + tag stay manual on purpose (see apps/desktop/RELEASING.md).
 * Pre-release (rc/beta) is not supported here — use `pnpm version prerelease`
 * and sync the sibling package.json files by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const kind = args[0];
const rootFlag = args.indexOf("--root");
const repoRoot = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : dirname(dirname(fileURLToPath(import.meta.url)));

const TARGETS = [
  ["repo root", join(repoRoot, "package.json")],
  ["apps/desktop", join(repoRoot, "apps/desktop/package.json")],
  ["ui", join(repoRoot, "ui/package.json")],
];

const KIND_STEP = { patch: 2, minor: 1, major: 0 };

function nextVersion(current, bumpKind) {
  const segments = current.split(".").map(Number);
  if (segments.length !== 3 || segments.some(Number.isNaN)) {
    throw new Error(`Not a x.y.z version: ${current}`);
  }
  const index = KIND_STEP[bumpKind];
  if (index === undefined) {
    throw new Error(`Unknown bump kind '${bumpKind}'; use patch|minor|major`);
  }
  segments[index] += 1;
  for (let i = index + 1; i < segments.length; i += 1) segments[i] = 0;
  return segments.join(".");
}

const versions = TARGETS.map(([, path]) => JSON.parse(readFileSync(path, "utf8")).version);
const unique = new Set(versions);
if (unique.size !== 1) {
  throw new Error(
    `Versions out of lockstep: ${[...unique].join(" vs ")}. Align them first (release.sh enforces this too).`,
  );
}
const current = versions[0];
const next = nextVersion(current, kind);

for (const [label, path] of TARGETS) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = next;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`${label}: ${current} -> ${next}`);
}
console.log("Remember: git commit + tag are manual (see apps/desktop/RELEASING.md).");
