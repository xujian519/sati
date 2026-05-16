#!/usr/bin/env node
/**
 * PilotDeck XHS Orchestration E2E Test
 *
 * Connects to PilotDeck gateway via WebSocket, sends a complex multi-domain
 * query, and verifies that autoOrchestrate triggers — the main agent delegates
 * work to sub-agents via the `agent` tool instead of executing directly.
 *
 * Usage:
 *   node test-orchestrate.mjs [--query "custom query"] [--timeout 600]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
// Node 22+ exposes WebSocket as a global (globalThis.WebSocket)

const PILOTDECK_HOME = join(homedir(), ".pilotdeck");
const GATEWAY_WS_URL = process.env.PILOTDECK_WS_URL || "ws://127.0.0.1:18789/ws";
const PROTOCOL_VERSION = "1.0";

const DEFAULT_QUERY = "帮我看一下马斯克相关的最新的 Xpost，做成小红书头图和笔记发";
const DEFAULT_TIMEOUT_S = 900;

function parseArgs() {
  const args = process.argv.slice(2);
  let query = DEFAULT_QUERY;
  let timeoutS = DEFAULT_TIMEOUT_S;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) query = args[++i];
    if (args[i] === "--timeout" && args[i + 1]) timeoutS = Number(args[++i]);
  }
  return { query, timeoutS };
}

function readToken() {
  const tokenPath = join(PILOTDECK_HOME, "server-token");
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch {
    console.error(`[ERROR] Cannot read token from ${tokenPath}`);
    console.error("        Is the PilotDeck gateway running?");
    process.exit(1);
  }
}

function readStats() {
  const statsPath = join(PILOTDECK_HOME, "router/stats.json");
  try {
    return JSON.parse(readFileSync(statsPath, "utf-8"));
  } catch {
    return {};
  }
}

function printStats(stats) {
  const g = stats.global || {};
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PilotDeck Orchestration E2E Report     ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`  Total requests:      ${g.totalRequests || 0}`);
  console.log(`  Total input tokens:  ${g.totalInputTokens || 0}`);
  console.log(`  Total output tokens: ${g.totalOutputTokens || 0}`);
  console.log(`  Total cost:          $${(g.totalCost || 0).toFixed(4)}`);
  console.log();

  if (g.perTier && Object.keys(g.perTier).length > 0) {
    console.log("  Per tier:");
    for (const [k, v] of Object.entries(g.perTier)) {
      console.log(`    ${k}: ${v}`);
    }
    console.log();
  }
  if (g.perRole && Object.keys(g.perRole).length > 0) {
    console.log("  Per role:");
    for (const [k, v] of Object.entries(g.perRole)) {
      console.log(`    ${k}: ${v}`);
    }
    console.log();
  }
  if (g.perModel && Object.keys(g.perModel).length > 0) {
    console.log("  Per model:");
    for (const [k, v] of Object.entries(g.perModel)) {
      console.log(`    ${k}: ${v}`);
    }
    console.log();
  }

  const hasComplex = g.perTier?.complex > 0;
  const hasSubagent = g.perRole?.subagent > 0;
  console.log("  ── Orchestration verdict ──");
  console.log(`  complex tier triggered: ${hasComplex ? "YES" : "NO"}`);
  console.log(`  sub-agents spawned:     ${hasSubagent ? `YES (${g.perRole.subagent})` : "NO"}`);
  if (hasComplex && hasSubagent) {
    console.log("  Result: PASS — orchestration worked end-to-end");
  } else if (!hasComplex) {
    console.log("  Result: FAIL — judge did not classify as complex");
    console.log("  Fix: adjust tokenSaver.rules or tiers.complex.description");
  } else {
    console.log("  Result: PARTIAL — complex triggered but no sub-agents");
    console.log("  Fix: check DEFAULT_ORCHESTRATION_PROMPT injection");
  }
  console.log();
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

async function main() {
  const { query, timeoutS } = parseArgs();
  const token = readToken();

  console.log(`[${ts()}] PilotDeck XHS Orchestration E2E Test`);
  console.log(`[${ts()}] Gateway: ${GATEWAY_WS_URL}`);
  console.log(`[${ts()}] Query: ${query}`);
  console.log(`[${ts()}] Timeout: ${timeoutS}s`);
  console.log();

  const ws = new globalThis.WebSocket(GATEWAY_WS_URL);
  const requestId = randomUUID();
  const sessionKey = `e2e-xhs-${Date.now()}`;

  let textBuffer = "";
  let agentCalls = 0;
  let toolCalls = 0;
  let done = false;

  const timeout = setTimeout(() => {
    console.error(`\n[${ts()}] TIMEOUT after ${timeoutS}s — aborting`);
    printStats(readStats());
    ws.close();
    process.exit(2);
  }, timeoutS * 1000);

  ws.addEventListener("open", () => {
    console.log(`[${ts()}] WebSocket connected, sending hello...`);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientName: "test",
      clientVersion: "1.0",
      token,
    }));
  });

  ws.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      return;
    }

    if (frame.type === "hello_ok") {
      console.log(`[${ts()}] Authenticated. Sending submit_turn...`);
      console.log(`[${ts()}] Session: ${sessionKey}`);
      console.log();
      ws.send(JSON.stringify({
        type: "request",
        id: requestId,
        method: "submit_turn",
        params: {
          sessionKey,
          channelKey: "test",
          message: query,
          projectKey: process.cwd(),
          mode: "bypassPermissions",
          maxTurns: 50,
        },
      }));
      return;
    }

    if (frame.type === "event" && frame.event) {
      const ev = frame.event;

      switch (ev.type) {
        case "turn_started":
          console.log(`[${ts()}] Turn started (runId: ${ev.runId})`);
          break;

        case "assistant_text_delta":
          textBuffer += ev.text;
          process.stdout.write(ev.text);
          break;

        case "assistant_thinking_delta":
          break;

        case "tool_call_started": {
          if (textBuffer.length > 0) {
            console.log(); // newline after text
            textBuffer = "";
          }
          toolCalls++;
          const isAgent = ev.name === "agent";
          if (isAgent) agentCalls++;
          const marker = isAgent ? " [ORCHESTRATE]" : "";
          console.log(`\n[${ts()}] ── tool_call_started: ${ev.name}${marker} ──`);
          if (ev.argsPreview) {
            const preview = ev.argsPreview.length > 200
              ? ev.argsPreview.slice(0, 200) + "..."
              : ev.argsPreview;
            console.log(`  args: ${preview}`);
          }
          break;
        }

        case "tool_call_finished":
          console.log(`[${ts()}] ── tool_call_finished: ${ev.toolName || "?"} — ok=${ev.ok} ──`);
          if (ev.resultPreview) {
            const preview = ev.resultPreview.length > 300
              ? ev.resultPreview.slice(0, 300) + "..."
              : ev.resultPreview;
            console.log(`  result: ${preview}`);
          }
          break;

        case "permission_request":
          console.log(`[${ts()}] Permission request for: ${ev.toolName} — auto-allowing (bypassPermissions mode)`);
          break;

        case "turn_completed":
          if (textBuffer.length > 0) {
            console.log();
            textBuffer = "";
          }
          done = true;
          console.log(`\n[${ts()}] ═══ Turn completed ═══`);
          console.log(`[${ts()}] Total tool calls: ${toolCalls}`);
          console.log(`[${ts()}] Agent (sub-agent) calls: ${agentCalls}`);

          setTimeout(() => {
            printStats(readStats());
            clearTimeout(timeout);
            ws.close();
            process.exit(0);
          }, 3000);
          break;
      }
    }

    if (frame.type === "response" && !frame.ok) {
      console.error(`\n[${ts()}] ERROR response:`, frame.error);
      clearTimeout(timeout);
      ws.close();
      process.exit(1);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error(`[${ts()}] WebSocket error:`, err.message || err);
    clearTimeout(timeout);
    process.exit(1);
  });

  ws.addEventListener("close", (event) => {
    if (!done) {
      console.log(`\n[${ts()}] WebSocket closed (code=${event.code})`);
      clearTimeout(timeout);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
