import type { NormalizedMessage } from "../sessionStoreCore";
import type { SessionActionContext } from "./context";

export function createActivityActions(ctx: SessionActionContext) {
  const { getSlot, notify } = ctx;

  const upsertActivity = (sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const key = msg.activityId || msg.id;
    const existingIndex = slot.activityMessages.findIndex(activity => (activity.activityId || activity.id) === key);

    if (existingIndex >= 0) {
      const updated = [...slot.activityMessages];
      updated[existingIndex] = msg;
      slot.activityMessages = updated;
    } else {
      slot.activityMessages = [...slot.activityMessages, msg];
    }

    notify(sessionId);
  };

  const setActivities = (sessionId: string, msgs: NormalizedMessage[]) => {
    const slot = getSlot(sessionId);
    const byKey = new Map<string, NormalizedMessage>();

    for (const msg of msgs) {
      if (msg.kind !== "agent_activity") continue;
      byKey.set(msg.activityId || msg.id, msg);
    }

    slot.activityMessages = Array.from(byKey.values());
    notify(sessionId);
  };

  return { upsertActivity, setActivities };
}
