import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUN = process.env.PILOTDECK_RUN_FRAMEWORK_E2E === "1";

test("WCB-CC smoke: In-process Gateway runs a minimal task end-to-end", { timeout: 300_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run WCB smoke test.");
    return;
  }

  const { createLocalGateway } = await import("../../src/cli/createLocalGateway.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-wcb-smoke-"));
  const testFile = path.join(tmpDir, "input.txt");
  fs.writeFileSync(testFile, "Hello World from WCB smoke test.");

  try {
    const { gateway } = createLocalGateway({
      projectRoot: tmpDir,
      permissionMode: "bypassPermissions",
    });

    const { sessionKey } = await gateway.newSession({ channelKey: "test" });
    assert.ok(sessionKey, "Must get a valid session key");

    const events: Array<{ type: string }> = [];
    for await (const event of gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      message: `Read the file at ${testFile} and tell me its contents.`,
    })) {
      events.push({ type: event.type });
    }

    assert.ok(events.length > 0, "Must receive at least one event from Gateway");
    assert.ok(
      events.some((e) =>
        e.type === "assistant_message" || e.type === "text_delta" ||
        e.type === "turn_completed" || e.type === "message_end",
      ),
      "Must receive a substantive event",
    );

    await gateway.closeSession({ sessionKey });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
