import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("exit_plan_mode elicitation maps to ExitPlanModeV2 permission frame", async () => {
  const { gatewayEventToFrames } = await import(
    pathToFileURL(resolve(process.cwd(), "ui/server/pilotdeck-bridge.js")).href
  );
  const frames = gatewayEventToFrames(
    {
      type: "elicitation_request",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "exit_plan_mode",
      questions: [{ question: "What should happen next?", header: "Plan", options: [] }],
      metadata: {
        source: "exit_plan_mode",
        plan: "# Plan\n\n- step 1",
        planFilePath: "/tmp/demo/.pilotdeck/plans/demo.md",
      },
    },
    "session-1",
    "pilotdeck",
  );

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.kind, "permission_request");
  assert.equal(frames[0]?.toolName, "ExitPlanModeV2");
  assert.equal(frames[0]?.isElicitation, true);
  assert.equal(frames[0]?.input?.plan, "# Plan\n\n- step 1");
  assert.equal(frames[0]?.input?.planFilePath, "/tmp/demo/.pilotdeck/plans/demo.md");
});
