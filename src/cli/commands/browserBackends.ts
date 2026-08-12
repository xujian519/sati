/**
 * `sati browsers` — 本机浏览器后端探测矩阵。
 *
 * 对应 docs/windows-browser-automation-plan.md §5.2.3：输出 ego lite / BrowserOS
 * neo / browser-use / @playwright/mcp 四层的可用性，让用户一眼看清当前机器
 * 有哪些浏览器后端可用，以及级联降级链（ego → BrowserOS neo → browser-use →
 * @playwright/mcp）中下一层应如何安装。
 *
 * 探测逻辑收敛在 src/browser/backend（与浏览器后端路由共用），本文件只负责输出。
 * 探测只读、不启动浏览器：browser-use 的 --version、BrowserOS neo 的 HTTP 握手，
 * 以及 `--doctor` 模式下 ego 的连接探针（spawn `ego-browser nodejs`，最长 8s）除外。
 * 默认（无 --doctor）单次探测 ≤ 5s。
 */

import { probeAllBackends } from "../../browser/backend/index.js";
import type { BackendProbeResult, BackendRouteOptions } from "../../browser/backend/index.js";

export function runBrowserBackendProbes(options: BackendRouteOptions = {}): Promise<BackendProbeResult[]> {
  return probeAllBackends(options);
}

export function formatBrowserBackendMatrix(results: BackendProbeResult[]): string {
  const lines: string[] = [];
  lines.push("Browser automation backends (cascade: ego lite → BrowserOS neo → browser-use → @playwright/mcp):");
  lines.push("");
  for (const { backend, probe } of results) {
    const badge = probe.status === "ok" ? "[ok ]" : probe.status === "warn" ? "[!  ]" : "[-- ]";
    lines.push(`  ${badge} ${backend.label.padEnd(20)} ${probe.detail}`);
    if (probe.status !== "ok" && probe.installHint) {
      lines.push(`        install: ${probe.installHint}`);
    }
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("  - BrowserOS neo MCP endpoint (127.0.0.1:9010) has NO authentication — any process on this");
  lines.push("    machine can control the browser. Confirm the listening pid above belongs to BrowserOS.");
  lines.push("  - Backend for a task is chosen once at session start (cold decision); it never switches mid-task.");
  return lines.join("\n");
}
