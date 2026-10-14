/**
 * `sati cron` — 定时任务管理（P2.7 从 `cli/sati.ts` 原样搬出）。
 *
 * 命令全部经**远端运行中的 server** 执行（`connectRemoteGatewayIfAvailable`）：cron 运行时
 * 由 server 进程持有，CLI 只做请求/打印，无 server 时明确报错退出码 1（不静默降级为本地假执行）。
 * 输出一律 `JSON.stringify(result, null, 2)`，供脚本消费。
 */

import { connectRemoteGatewayIfAvailable } from "../../gateway/client/index.js";
import { plainLogger as out } from "../../telemetry/index.js";
import { inferChannelKey, readNumberFlag, readStringFlag } from "./flagParsing.js";

export async function runCronCommand(argv: string[]): Promise<void> {
  const gateway = await connectRemoteGatewayIfAvailable();
  if (!gateway) {
    out.error("sati cron requires a running sati server.");
    process.exitCode = 1;
    return;
  }
  const command = argv[0];
  if (command === "list") {
    const result = await gateway.cronList({
      includeHistory: argv.includes("--history"),
      limit: readNumberFlag(argv, "--limit"),
    });
    out.info(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "create") {
    const message = readStringFlag(argv, "--message");
    const sessionKey = readStringFlag(argv, "--session");
    const once = readStringFlag(argv, "--once");
    const cron = readStringFlag(argv, "--cron");
    if (!message || !sessionKey || (!once && !cron)) {
      out.error("Usage: sati cron create --session <sessionKey> --message <text> (--once <iso> | --cron <expr>)");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronCreate({
      message,
      sessionKey,
      channelKey: readStringFlag(argv, "--channel") ?? inferChannelKey(sessionKey),
      projectKey: readStringFlag(argv, "--project") ?? process.cwd(),
      schedule: once ? { type: "once", runAt: once } : { type: "cron", expression: cron! },
      timezone: readStringFlag(argv, "--timezone"),
    });
    out.info(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "delete") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    if (!taskId) {
      out.error("Usage: sati cron delete <taskId> [--stop-running]");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronDelete({ taskId, stopRunning: argv.includes("--stop-running") });
    out.info(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "stop") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    const runId = readStringFlag(argv, "--run");
    if (!taskId && !runId) {
      out.error("Usage: sati cron stop <taskId> or sati cron stop --run <runId>");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronStop({ taskId, runId });
    out.info(JSON.stringify(result, null, 2));
    return;
  }
  out.error("Usage: sati cron <list|create|delete|stop>");
  process.exitCode = 1;
}
