import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildTurnEnvironment } from "../../src/agent/loop/AgentLoop.js";

test("turn environment provides an isolated Sati-owned work directory", () => {
  const cwd = "/workspace/project";
  const env = buildTurnEnvironment({ PATH: "/custom/bin", KEEP_ME: "yes" }, cwd, "web:s_123/unsafe", "turn:456 unsafe");

  assert.equal(env.PATH, "/custom/bin");
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.SESSION_ID, "web:s_123/unsafe");
  assert.equal(env.TURN_ID, "turn:456 unsafe");
  assert.equal(env.WORK_DIR, join(cwd, ".sati", "work", "web-s_123-unsafe", "turn-456-unsafe"));
});

test("turn environment inherits the process environment when no override is configured", () => {
  const markerName = "SATI_TURN_ENV_INHERITANCE_TEST";
  const previousMarker = process.env[markerName];
  process.env[markerName] = "inherited";

  try {
    const env = buildTurnEnvironment(undefined, "/workspace/project", "session", "turn");

    assert.equal(env[markerName], "inherited");
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previousMarker === undefined) {
      delete process.env[markerName];
    } else {
      process.env[markerName] = previousMarker;
    }
  }
});
