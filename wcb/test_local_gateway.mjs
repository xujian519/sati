#!/usr/bin/env node
/**
 * Minimal test client for PilotDeck Gateway WebSocket.
 * Sends task_2 prompt, streams events, detects the empty-bash-loop fix.
 *
 * Usage:
 *   node wcb/test_local_gateway.mjs [--port 18800] [--timeout 600000]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import WebSocket from "ws";

const PROTOCOL_VERSION = "1.0";
const WS_URL = `ws://127.0.0.1:${process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "18800"}/ws`;
const TOKEN_PATH = resolve(process.env.PILOT_HOME ?? `${process.env.HOME}/.pilotdeck`, "server-token");
const TOKEN = readFileSync(TOKEN_PATH, "utf-8").trim();
const TIMEOUT_MS = process.argv.includes("--timeout")
  ? parseInt(process.argv[process.argv.indexOf("--timeout") + 1], 10)
  : 600_000;

const WORKSPACE_CWD = "/tmp/wcb_test_task2";
const SESSION_KEY = `wcb-task2-test-${Date.now()}`;

const PROMPT = `工作目录 \`/tmp_workspace/\` 下有我们公司 2024-2025 年的业务数据，一共五个数据源：
- \`sales.csv\` — 销售订单明细
- \`inventory.csv\` — 库存快照
- \`returns.csv\` — 退货记录
- \`marketing_spend.csv\` — 各渠道月度营销投放和转化数据
- \`customer_feedback.csv\` — 客户满意度评分和评价文本

另外有一份汇率表 \`exchange_rates.json\`。

帮我出一份完整的年度商业分析报告 PDF，统一用美元计价。报告里要有：
1. 关键指标汇总（营收、均单价、退货率等基础指标）
2. 季度趋势变化对比（Q1-Q4 营收趋势，环比增长率）
3. 营销 ROI 分析（各渠道投入产出比，哪个渠道最划算）
4. 客户满意度与退货率的关联分析
5. 可视化图表（至少3张，覆盖趋势、分布、对比，多多益善）
6. 综合分析解读和建议

中间的合并数据和统计结果也保留下来方便后续用。

所有产出放到 \`/tmp_workspace/results/\`，按以下文件名保存：
- \`merged.csv\` — 合并后的全量数据（含美元计价列）
- \`stats.json\` — 关键指标汇总，至少包含：\`total_revenue\`、\`avg_order_value\`、\`return_rate\`、\`top_products\`、\`regional_breakdown\`、\`quarterly_trends\`、\`marketing_roi\`、\`avg_satisfaction\`
- \`charts/\` — 图表目录，至少5张 PNG 图
- \`report.pdf\` — 最终报告 PDF（至少5页）`;

function ts() { return new Date().toISOString().slice(11, 19); }

function log(tag, ...args) { console.log(`${ts()} [${tag}]`, ...args); }

const stats = {
  toolCalls: 0,
  toolErrors: 0,
  emptyBashCalls: 0,
  textChunks: 0,
  events: [],
};

const ws = new WebSocket(WS_URL);

const timer = setTimeout(() => {
  log("TIMEOUT", `No completion after ${TIMEOUT_MS / 1000}s`);
  ws.close();
  process.exit(2);
}, TIMEOUT_MS);

let reqId = 0;

ws.on("open", () => {
  log("WS", `Connected to ${WS_URL}`);
  ws.send(JSON.stringify({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "1.0.0",
    token: TOKEN,
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "hello_ok") {
    log("AUTH", "Authenticated OK");
    const id = `req-${++reqId}`;
    log("SEND", `Submitting turn (session=${SESSION_KEY})`);
    ws.send(JSON.stringify({
      type: "request",
      id,
      method: "submit_turn",
      params: {
        sessionKey: SESSION_KEY,
        channelKey: "test",
        message: PROMPT,
        workspaceCwd: WORKSPACE_CWD,
        mode: "bypassPermissions",
        maxTurns: 40,
      },
    }));
    return;
  }

  if (msg.type === "event") {
    const ev = msg.event;
    switch (ev.type) {
      case "turn_started":
        log("TURN", `Started (runId=${ev.runId})`);
        break;
      case "assistant_text_delta":
        stats.textChunks++;
        process.stdout.write(ev.text);
        break;
      case "tool_call_started":
        stats.toolCalls++;
        log("TOOL", `▶ ${ev.name} (id=${ev.toolCallId})${ev.argsPreview ? " args=" + ev.argsPreview.slice(0, 200) : ""}`);
        if (ev.name === "bash" && (!ev.argsPreview || ev.argsPreview === "{}" || ev.argsPreview === "")) {
          stats.emptyBashCalls++;
          log("WARN", `⚠ Empty bash call #${stats.emptyBashCalls}`);
        }
        break;
      case "tool_call_finished":
        if (!ev.ok) {
          stats.toolErrors++;
          log("TOOL", `✗ ${ev.toolName ?? ev.toolCallId} FAILED (code=${ev.errorCode ?? "?"})${ev.resultPreview ? " → " + ev.resultPreview.slice(0, 200) : ""}`);
        } else {
          log("TOOL", `✓ ${ev.toolName ?? ev.toolCallId} OK${ev.resultPreview ? " → " + ev.resultPreview.slice(0, 120) : ""}`);
        }
        break;
      case "error":
        log("ERROR", `${ev.message} (code=${ev.code}, recoverable=${ev.recoverable})`);
        break;
      case "turn_completed":
        log("DONE", `Turn completed. finishReason=${ev.finishReason}`);
        log("STATS", JSON.stringify({
          toolCalls: stats.toolCalls,
          toolErrors: stats.toolErrors,
          emptyBashCalls: stats.emptyBashCalls,
          textChunks: stats.textChunks,
          usage: ev.usage,
        }, null, 2));
        if (stats.emptyBashCalls > 0) {
          log("RESULT", `⚠ Detected ${stats.emptyBashCalls} empty bash calls (previously would loop infinitely)`);
        } else {
          log("RESULT", "✓ No empty bash loops detected");
        }
        clearTimeout(timer);
        ws.close();
        break;
      default:
        log("EVENT", `${ev.type}${JSON.stringify(ev).length < 200 ? " " + JSON.stringify(ev) : ""}`);
    }
    return;
  }

  if (msg.type === "response") {
    log("RESP", `id=${msg.id} ok=${msg.ok}`);
    if (!msg.ok) {
      log("RESP-ERR", JSON.stringify(msg.error));
    }
  }
});

ws.on("error", (err) => {
  log("WS-ERR", err.message);
  clearTimeout(timer);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  log("WS", `Closed (code=${code}, reason=${reason})`);
  clearTimeout(timer);
  process.exit(stats.emptyBashCalls > 5 ? 1 : 0);
});
