import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { buildTurnEnvironment } from "../../src/agent/loop/AgentLoop.js";

test("turn environment provides an isolated PilotDeck-owned work directory", () => {
  const cwd = "/workspace/project";
  const env = buildTurnEnvironment(
    { PATH: "/custom/bin", KEEP_ME: "yes" },
    cwd,
    "web:s_123/unsafe",
    "turn:456 unsafe",
  );

  assert.equal(env.PATH, "/custom/bin");
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.PILOTDECK_SESSION_ID, "web:s_123/unsafe");
  assert.equal(env.PILOTDECK_TURN_ID, "turn:456 unsafe");
  assert.equal(
    env.PILOTDECK_WORK_DIR,
    join(cwd, ".pilotdeck", "work", "web-s_123-unsafe", "turn-456-unsafe"),
  );
});
