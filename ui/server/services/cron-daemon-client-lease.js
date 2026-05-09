import { ensureCronDaemonForUiStartup } from './cron-daemon-startup.js';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;

export function startCronDaemonClientLease({
  clientId,
  clientKind = 'webui',
  processId = process.pid,
  getProjectRoots = () => [],
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  ensureCronDaemonFn = ensureCronDaemonForUiStartup,
  sendCronDaemonRequestFn = sendCronDaemonRequest
}) {
  let registered = false;
  let stopped = false;

  const buildPayload = () => ({
    clientId,
    clientKind,
    processId,
    projectRoots: getProjectRoots()
  });

  const register = async () => {
    if (stopped) return;
    await ensureCronDaemonFn();
    const response = await sendCronDaemonRequestFn({
      type: 'register_client',
      ...buildPayload()
    });
    if (stopped) {
      if (response?.ok) {
        await sendCronDaemonRequestFn({
          type: 'unregister_client',
          clientId
        }).catch(() => {});
      }
      return;
    }
    if (response?.ok) {
      registered = true;
    }
  };

  const heartbeat = async () => {
    if (stopped) return;
    if (!registered) {
      await register();
      return;
    }

    const response = await sendCronDaemonRequestFn({
      type: 'client_heartbeat',
      clientId,
      projectRoots: getProjectRoots()
    });
    if (!response?.ok) {
      registered = false;
      await register();
    }
  };

  void register().catch((error) => {
    registered = false;
    console.warn('[cron-daemon-client-lease] register failed:', error?.message || error);
  });

  const timer = setInterval(() => {
    void heartbeat().catch((error) => {
      registered = false;
      console.warn('[cron-daemon-client-lease] heartbeat failed:', error?.message || error);
    });
  }, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (!registered) return;
      await sendCronDaemonRequestFn({
        type: 'unregister_client',
        clientId
      }).catch((error) => {
        console.warn('[cron-daemon-client-lease] unregister failed:', error?.message || error);
      });
      registered = false;
    }
  };
}
