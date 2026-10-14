/**
 * `sati tui` — 交互式终端 UI（P2.7 从 `cli/sati.ts` 的 `main` 的 tui 分支原样搬出）。
 *
 * 三级回退，任一环失败都往下走且留痕：
 * ① 探测本机已运行的 sati server（读 `gateway.port`，读配置失败回落 19789）→ 远端模式直连；
 * ② 远端握手后崩溃 → 本地内嵌 gateway；
 * ③ 内嵌 gateway 起不来 → `createFallbackGateway` 直连重试，避免 CLI 直接崩溃。
 * 非 TTY 直接拒绝（Ink 需要交互终端）。
 *
 * **导入时机是语义**：`loadPilotConfig` / gateway / session 这些重模块必须在 TTY 检查**之后**
 * 才 import（原分支即如此）——`session/index.js` 会拉起 `node:sqlite`，提前加载会让
 * `sati tui` 在非 TTY 下先吐 ExperimentalWarning 再报错（P2.7 A/B 实测到的差异）。
 */

import { logger, plainLogger as out } from "../../telemetry/index.js";
import { createFallbackGateway } from "./fallbackGateway.js";

export async function runTuiCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    out.error("sati tui requires an interactive terminal.");
    process.exitCode = 1;
    return;
  }
  const { loadPilotConfig } = await import("../../pilot/index.js");
  const { connectRemoteGatewayIfAvailable } = await import("../../gateway/client/index.js");
  const { TuiChannel } = await import("../../adapters/channel/tui/TuiChannel.js");
  const { sanitizeSessionIdForPath } = await import("../../session/index.js");
  const { installGlobalProxy } = await import("../proxy.js");

  // 读取 gateway 端口以探测运行中的 server；本地配置不完整（如模型
  // provider 未配置）不应阻止 TUI 连接远端 server，故此处容错回退默认端口。
  let gatewayPort = 19789;
  try {
    const snapshot = loadPilotConfig({ projectRoot: process.cwd() });
    gatewayPort = snapshot.config.gateway?.port ?? 19789;
  } catch (error) {
    logger.warn(
      `读取 gateway 端口失败，回退默认 ${gatewayPort}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const probeUrl = `http://127.0.0.1:${gatewayPort}`;
  // 先探测已运行的 sati server；命中时无需在当前进程构建完整本地 gateway。
  const remote = await connectRemoteGatewayIfAvailable({ url: probeUrl });
  if (remote) {
    try {
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "Sati",
        mode: "remote",
        serverUrl: probeUrl,
      }).start({ gateway: remote });
      return;
    } catch (error) {
      // 远端启动失败（如握手后崩溃）：回退本地 gateway，恢复自动探测的兜底语义。
      logger.warn(`连接远端 server 失败，回退本地 gateway: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await installGlobalProxy();
  const fallbackGateway = createFallbackGateway(sanitizeSessionIdForPath);
  try {
    const { createLocalGateway } = await import("../createLocalGateway.js");
    const { gateway: local } = createLocalGateway({ projectRoot: process.cwd() });
    await new TuiChannel({
      projectKey: process.cwd(),
      cwd: process.cwd(),
      model: "Sati",
      mode: "in_process",
    }).start({ gateway: local });
  } catch {
    // 内嵌 gateway 启动 TUI 失败 → 回退到直连模式重试，避免 CLI 直接崩溃。
    await new TuiChannel({
      projectKey: process.cwd(),
      cwd: process.cwd(),
      model: "Sati",
      mode: "in_process",
    }).start({ gateway: fallbackGateway });
  }
  return;
}
