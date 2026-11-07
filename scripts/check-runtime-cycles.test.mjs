import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { findStaticCycles } from "./check-runtime-cycles.mjs";

const root = path.resolve("/virtual/src");
const a = path.join(root, "a.ts");
const b = path.join(root, "b.ts");
const c = path.join(root, "c.ts");

function cyclesFor(sources) {
  return findStaticCycles(Object.keys(sources), file => sources[file] ?? "");
}

describe("findStaticCycles", () => {
  it("reports a two-file import cycle", () => {
    const cycles = cyclesFor({
      [a]: 'import { b } from "./b.js";\nexport const a = 1;',
      [b]: 'import { a } from "./a.js";\nexport const b = 1;',
    });
    assert.deepEqual(
      cycles.map(group => group.sort()),
      [[a, b]],
    );
  });

  it("ignores type-only imports and dynamic imports", () => {
    const cycles = cyclesFor({
      [a]: 'import type { B } from "./b.js";\nexport const a = 1;',
      [b]: 'export type B = 1;\nvoid import("./a.js");',
    });
    assert.deepEqual(cycles, []);
  });

  it("resolves directory index files and emitted .js specifiers", () => {
    const index = path.join(root, "nested", "index.ts");
    const cycles = cyclesFor({
      [a]: 'import { nested } from "./nested/index.js";',
      [index]: 'import { a } from "../a.js";',
      [c]: "export const c = 1;",
    });
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].sort(), [a, index].sort());
  });
});
