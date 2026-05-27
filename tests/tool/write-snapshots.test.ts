import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop, type AgentLoopSeedState } from "../../src/agent/loop/AgentLoop.js";
import type { PilotDeckWriteSnapshotEntry } from "../../src/tool/protocol/types.js";
import { createAgentLoopFixture } from "../helpers/agent.js";

test("AgentLoop.snapshotFileState round-trips seedState", () => {
  const seedState: AgentLoopSeedState = {
    readFileState: new Map([
      ["/abs/file.txt::text", { mtimeMs: 100, kind: "text" as const }],
    ]),
    writeSnapshots: new Map([
      ["/abs/file.txt", { absolutePath: "/abs/file.txt", mtimeMs: 100, contentHash: "abc123" }],
    ]),
  };

  const { config, dependencies } = createAgentLoopFixture({ scripts: [] });
  const loop = new AgentLoop(config, dependencies, seedState);
  const snapshot = loop.snapshotFileState();
  const readFileState = snapshot.readFileState;
  const writeSnapshots = snapshot.writeSnapshots;
  assert.ok(readFileState);
  assert.ok(writeSnapshots);

  assert.equal(readFileState.size, 1);
  assert.equal(writeSnapshots.size, 1);
  assert.deepEqual(
    writeSnapshots.get("/abs/file.txt"),
    seedState.writeSnapshots!.get("/abs/file.txt"),
  );
  assert.deepEqual(
    readFileState.get("/abs/file.txt::text"),
    seedState.readFileState!.get("/abs/file.txt::text"),
  );
});

test("AgentLoop.snapshotFileState returns independent clones", () => {
  const seedState: AgentLoopSeedState = {
    writeSnapshots: new Map([
      ["/abs/a.txt", { absolutePath: "/abs/a.txt", mtimeMs: 100, contentHash: "aaa" }],
    ]),
  };

  const { config, dependencies } = createAgentLoopFixture({ scripts: [] });
  const loop = new AgentLoop(config, dependencies, seedState);
  const snap1 = loop.snapshotFileState();
  const snap2 = loop.snapshotFileState();
  const snap1WriteSnapshots = snap1.writeSnapshots;
  const snap2WriteSnapshots = snap2.writeSnapshots;
  assert.ok(snap1WriteSnapshots);
  assert.ok(snap2WriteSnapshots);

  snap1WriteSnapshots.set("/abs/b.txt", {
    absolutePath: "/abs/b.txt",
    mtimeMs: 200,
    contentHash: "bbb",
  });
  assert.equal(
    snap2WriteSnapshots.has("/abs/b.txt"),
    false,
    "mutations to snap1 should not affect snap2",
  );
});

test("PilotDeckWriteSnapshotEntry stores offset/limit for partial reads", () => {
  const partial: PilotDeckWriteSnapshotEntry = {
    absolutePath: "/file.txt",
    mtimeMs: 100,
    contentHash: "abc",
    offset: 5,
    limit: 10,
  };
  assert.equal(partial.offset, 5);
  assert.equal(partial.limit, 10);

  const full: PilotDeckWriteSnapshotEntry = {
    absolutePath: "/file.txt",
    mtimeMs: 100,
    contentHash: "abc",
  };
  assert.equal(full.offset, undefined);
  assert.equal(full.limit, undefined);
});
