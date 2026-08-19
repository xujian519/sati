/**
 * TeamEvent 事件族：gateway team_event 帧包装纯函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toGatewayEvent } from "../../../../src/agent/team/index.js";
import type { TeamEvent } from "../../../../src/agent/team/protocol/events.js";

test("toGatewayEvent：TeamEvent 包装为 team_event 帧，载荷保真", () => {
  const event: TeamEvent = {
    type: "task_claimed",
    teamId: "t1",
    taskId: "t2",
    memberId: "m1",
    attempt: 1,
    attemptId: "a1",
  };
  const frame = toGatewayEvent(event);
  assert.equal(frame.type, "team_event");
  assert.equal(frame.teamId, "t1");
  assert.deepEqual(frame.event, event);
});
