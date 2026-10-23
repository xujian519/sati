import { createEmptySlot, createRafNotifyScheduler, type RafScheduler, type SessionSlot } from "../sessionStoreCore";

export type SessionActionDeps = {
  storeRef: { current: Map<string, SessionSlot> };
  activeSessionIdRef: { current: string | null };
  notifySchedulerRef: { current: RafScheduler | null };
  setTick: (updater: (count: number) => number) => void;
};

export type SessionActionContext = SessionActionDeps & {
  getNotifyScheduler: () => RafScheduler;
  notify: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  getSlot: (sessionId: string) => SessionSlot;
  has: (sessionId: string) => boolean;
};

export function createSessionActionContext(deps: SessionActionDeps): SessionActionContext {
  const { storeRef, activeSessionIdRef, notifySchedulerRef, setTick } = deps;

  const getNotifyScheduler = (): RafScheduler => {
    if (notifySchedulerRef.current == null) {
      notifySchedulerRef.current = createRafNotifyScheduler(
        sessionId => sessionId === activeSessionIdRef.current,
        () => setTick(n => n + 1),
      );
    }
    return notifySchedulerRef.current;
  };

  const notify = (sessionId: string) => {
    getNotifyScheduler().schedule(sessionId);
  };

  const setActiveSession = (sessionId: string | null) => {
    const changed = activeSessionIdRef.current !== sessionId;
    activeSessionIdRef.current = sessionId;
    if (changed) {
      setTick(n => n + 1);
    }
  };

  const getSlot = (sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  };

  const has = (sessionId: string) => storeRef.current.has(sessionId);

  return {
    ...deps,
    getNotifyScheduler,
    notify,
    setActiveSession,
    getSlot,
    has,
  };
}
