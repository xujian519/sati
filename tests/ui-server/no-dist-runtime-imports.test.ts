import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const UI_SERVER_DIR = join(process.cwd(), "ui", "server");
const FORBIDDEN_DIST_SRC_IMPORT = /(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*dist\/src\//;

async function listJavaScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
      if (/\.[cm]?js$/.test(entry.name)) return [entryPath];
      return [];
    }),
  );
  return files.flat();
}

test("ui/server source does not import compiled dist/src runtime files", async () => {
  const violations: string[] = [];
  for (const file of await listJavaScriptFiles(UI_SERVER_DIR)) {
    const source = await readFile(file, "utf8");
    source.split(/\r?\n/).forEach((line, index) => {
      if (FORBIDDEN_DIST_SRC_IMPORT.test(line)) {
        violations.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});
