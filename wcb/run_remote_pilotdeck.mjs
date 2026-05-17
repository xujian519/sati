#!/usr/bin/env node
/**
 * WildClawBench-CC remote runner — drives a PilotDeck Web UI instance via
 * REST + WebSocket APIs.  No SSH required; workspace files are uploaded
 * through the file-upload endpoint, prompts are sent over WebSocket, and
 * results are downloaded back for local grading.
 *
 * Usage:
 *   node wcb/run_remote_pilotdeck.mjs --host http://58.57.119.12:52006 \
 *     --category 0510_Orchestration_Demo --filter task_2
 */

import { resolve, basename, dirname, join } from "node:path";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
} from "node:fs";
import { execSync, spawn } from "node:child_process";
import WebSocket from "ws";

// ── Constants ───────────────────────────────────────────────────────────

const PILOTDECK_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const WCB_ROOT = resolve(process.env.WCB_ROOT ?? join(PILOTDECK_ROOT, "../WildClawBench/WildClawBench-github"));
const WCB_ORIG = resolve(WCB_ROOT, "../WildClawBench-orig");
const WCB_CC   = resolve(WCB_ROOT, "../WildClawBench-cc");
const REMOTE_BASE = "/home/liyishan";

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [${tag}]`, ...args);
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {
    host: process.env.PILOTDECK_HOST || "http://58.57.119.12:52010",
    category: "0510_Orchestration_Demo",
    filter: "",
    limit: 0,
    outputDir: null,
    timeoutMs: 900_000,
    skipGrading: false,
    task: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i], n = argv[i + 1];
    switch (f) {
      case "--host":         a.host = n; i++; break;
      case "--task":         a.task = n; i++; break;
      case "--category":     a.category = n; i++; break;
      case "--filter":       a.filter = n; i++; break;
      case "--limit":        a.limit = parseInt(n, 10); i++; break;
      case "--output-dir":   a.outputDir = n; i++; break;
      case "--timeout":      a.timeoutMs = parseInt(n, 10); i++; break;
      case "--skip-grading": a.skipGrading = true; break;
    }
  }
  return a;
}

// ── Task Parser ─────────────────────────────────────────────────────────

async function parseTaskMd(taskFile) {
  const content = readFileSync(taskFile, "utf-8");
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
  if (!fmMatch) throw new Error(`YAML frontmatter not found: ${taskFile}`);
  const YAML = await import("yaml");
  const metadata = YAML.parse(fmMatch[1]);
  const body = fmMatch[2];
  const sections = {};
  let cur = null, lines = [];
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { if (cur) sections[cur] = lines.join("\n").trim(); cur = h[1]; lines = []; }
    else lines.push(line);
  }
  if (cur) sections[cur] = lines.join("\n").trim();
  const strip = (r) => r.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  let workspacePath = strip(sections["Workspace Path"] ?? "");
  if (!workspacePath.startsWith("/")) {
    for (const root of [WCB_ROOT, WCB_ORIG, WCB_CC]) {
      const c = resolve(root, workspacePath);
      if (existsSync(c)) { workspacePath = c; break; }
    }
  }
  return {
    taskId: metadata.id ?? basename(taskFile, ".md"),
    prompt: (sections["Prompt"] ?? "").trim(),
    workspacePath,
    automatedChecks: strip(sections["Automated Checks"] ?? ""),
    warmup: strip(sections["Warmup"] ?? ""),
    timeoutSeconds: parseInt(metadata.timeout_seconds ?? "900", 10),
    filePath: resolve(taskFile),
    category: basename(dirname(resolve(taskFile))),
  };
}

// ── Task Discovery ──────────────────────────────────────────────────────

function discoverTasks(categoryDir, filter, limit) {
  for (const root of [WCB_ROOT, WCB_ORIG, WCB_CC]) {
    const d = resolve(root, "tasks", categoryDir);
    if (existsSync(d)) {
      let files = readdirSync(d).filter(f => f.endsWith(".md")).sort().map(f => join(d, f));
      if (filter) files = files.filter(f => f.includes(filter));
      if (limit > 0) files = files.slice(0, limit);
      return files;
    }
  }
  throw new Error(`Tasks directory not found: ${categoryDir}`);
}

// ── REST helpers ────────────────────────────────────────────────────────

async function api(host, method, path, body) {
  const url = `${host}${path}`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: res.status }; }
}

async function uploadFile(host, projectName, localPath) {
  const fname = basename(localPath);
  const blob = readFileSync(localPath);
  const boundary = `----WCBUpload${Date.now()}`;
  const crlf = "\r\n";
  const header = `--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="${fname}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`;
  const footer = `${crlf}--${boundary}--${crlf}`;
  const body = Buffer.concat([Buffer.from(header), blob, Buffer.from(footer)]);
  const res = await fetch(
    `${host}/api/projects/${encodeURIComponent(projectName)}/files/upload`,
    { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body },
  );
  return res.json();
}

async function downloadFile(host, projectName, remotePath) {
  const url = `${host}/api/projects/${encodeURIComponent(projectName)}/files/content?path=${encodeURIComponent(remotePath)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function listFiles(host, projectName) {
  const url = `${host}/api/projects/${encodeURIComponent(projectName)}/files`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

function flattenTree(nodes, parentRel) {
  const files = [];
  for (const node of nodes) {
    const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
    if (node.type === "directory" && Array.isArray(node.children)) {
      files.push(...flattenTree(node.children, rel));
    } else if (node.type === "file") {
      files.push({ path: node.path, rel, size: node.size ?? 0 });
    }
  }
  return files;
}

// ── Upload workspace ────────────────────────────────────────────────────

async function uploadWorkspace(host, projectName, task) {
  const execDir = join(task.workspacePath, "exec");
  const srcDir = existsSync(execDir) ? execDir : task.workspacePath;
  if (!existsSync(srcDir)) {
    log(task.taskId, `WARNING: workspace source not found: ${srcDir}`);
    return 0;
  }

  const files = [];
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else files.push({ abs: full, rel: r, size: statSync(full).size });
    }
  };
  walk(srcDir, "");

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  log(task.taskId, `Workspace: ${files.length} files, ${(totalSize / 1024).toFixed(0)}K total`);

  if (files.length > 50 || totalSize > 2_000_000) {
    log(task.taskId, "Large workspace → compressing to tar.gz");
    const tarPath = `/tmp/wcb_upload_${task.taskId}.tar.gz`;
    execSync(`tar czf ${tarPath} -C "${srcDir}" .`, { stdio: "pipe" });
    const tarSize = statSync(tarPath).size;
    log(task.taskId, `Compressed: ${(tarSize / 1024 / 1024).toFixed(1)}MB`);
    const r = await uploadFile(host, projectName, tarPath);
    log(task.taskId, `Upload tar.gz: ${r.success ? "OK" : JSON.stringify(r)}`);
    return -1;
  }

  const dirs = new Set();
  for (const f of files) {
    const d = dirname(f.rel);
    if (d !== "." && !dirs.has(d)) {
      await api(host, "POST", "/api/create-folder", { path: `${REMOTE_BASE}/wcb_${task.taskId}/${d}` });
      dirs.add(d);
    }
    const r = await uploadFile(host, projectName, f.abs);
    if (!r.success) log(task.taskId, `Upload failed: ${f.rel} — ${JSON.stringify(r)}`);
  }

  const gtDir = join(task.workspacePath, "gt");
  if (existsSync(gtDir)) {
    await api(host, "POST", "/api/create-folder", { path: `${REMOTE_BASE}/wcb_${task.taskId}/gt` });
    const gtEntries = [];
    const walkGt = (dir, rel) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walkGt(full, r);
        else gtEntries.push({ abs: full, rel: `gt/${r}` });
      }
    };
    walkGt(gtDir, "");
    for (const f of gtEntries) {
      const d = dirname(f.rel);
      if (!dirs.has(d)) {
        await api(host, "POST", "/api/create-folder", { path: `${REMOTE_BASE}/wcb_${task.taskId}/${d}` });
        dirs.add(d);
      }
      await uploadFile(host, projectName, f.abs);
    }
    log(task.taskId, `Ground truth: ${gtEntries.length} files uploaded`);
  }

  log(task.taskId, `Uploaded ${files.length} workspace files`);
  return files.length;
}

// ── WebSocket agent execution ───────────────────────────────────────────

function runAgentViaWebSocket(host, projectPath, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const wsUrl = host.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    const events = [];
    let completed = false;
    let sessionId = null;
    let toolCallsSeen = 0;
    let continueAttempts = 0;
    const MAX_CONTINUE = 2;
    let pendingContinue = false;

    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        log("ws", `TIMEOUT after ${timeoutMs / 1000}s`);
        if (sessionId) ws.send(JSON.stringify({ type: "abort-session", sessionId }));
        setTimeout(() => { ws.close(); resolve({ events, timedOut: true, sessionId }); }, 3000);
      }
    }, timeoutMs);

    function sendCommand(cmd) {
      ws.send(JSON.stringify({
        type: "pilotdeck-command",
        command: cmd,
        options: {
          projectPath,
          cwd: projectPath,
          permissionMode: "bypassPermissions",
          toolsSettings: { skipPermissions: true },
          sessionId,
        },
      }));
    }

    ws.on("open", () => {
      log("ws", `Connected to ${wsUrl}`);
      sendCommand(prompt);
      log("ws", `Prompt sent (${prompt.length} chars)`);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        events.push({ ...msg, _ts: Date.now() });

        if (msg.kind === "session_created" || msg.newSessionId) {
          sessionId = msg.newSessionId || msg.sessionId;
          log("ws", `Session: ${sessionId}`);
        }

        if (msg.kind === "tool_use") {
          toolCallsSeen++;
          const name = msg.toolName || msg.name || msg.tool || "?";
          const input = msg.toolInput || msg.input;
          const snippet = input?.command?.slice(0, 200) || JSON.stringify(input || {}).slice(0, 150);
          log("ws", `Tool[${toolCallsSeen}]: ${name} → ${snippet}`);
        } else if (msg.kind === "tool_result") {
          const out = (msg.content || msg.output || msg.text || "").slice(0, 200);
          log("ws", `Tool done: err=${!!msg.isError} ${out}`);
        } else if (msg.kind === "stream_delta") {
          const text = msg.content || msg.text || "";
          if (text) process.stdout.write(text);
        } else if (msg.kind === "error") {
          log("ws", `ERROR: ${msg.message || msg.text || JSON.stringify(msg)}`);
        } else if (msg.kind === "status") {
          log("ws", `Status: ${msg.text || msg.event || "?"}`);
        } else if (msg.kind === "complete") {
          if (toolCallsSeen === 0 && continueAttempts < MAX_CONTINUE && !pendingContinue) {
            continueAttempts++;
            pendingContinue = true;
            log("ws", `Complete w/o tools (attempt ${continueAttempts}/${MAX_CONTINUE}), will continue in 2s...`);
            setTimeout(() => {
              pendingContinue = false;
              sendCommand(
                "You did NOT execute any tools. You MUST use bash, write_file, read_file, or web_search tools NOW to complete the task. " +
                "Execute commands immediately — do not describe them. Do not ask questions. Start with `bash` to run the first command."
              );
            }, 2000);
          } else if (!pendingContinue) {
            log("ws", `Complete (exit=${msg.exitCode}) tools=${toolCallsSeen}`);
            completed = true;
            clearTimeout(timer);
            ws.close();
            resolve({ events, timedOut: false, sessionId });
          }
        }
      } catch { /* non-JSON — ignore */ }
    });

    ws.on("error", (err) => {
      log("ws", `WebSocket error: ${err.message}`);
      if (!completed) { completed = true; clearTimeout(timer); reject(err); }
    });

    ws.on("close", () => {
      if (!completed) { completed = true; clearTimeout(timer); resolve({ events, timedOut: false, sessionId }); }
    });
  });
}

// ── Download results ────────────────────────────────────────────────────

async function downloadResults(host, projectName, localDir) {
  mkdirSync(localDir, { recursive: true });

  const tree = await listFiles(host, projectName);
  const allFiles = flattenTree(tree, "");
  const resultFiles = allFiles.filter(f => f.rel.startsWith("results/"));

  log("download", `Tree: ${allFiles.length} total, ${resultFiles.length} under results/`);

  let downloaded = 0;
  for (const f of resultFiles) {
    const content = await downloadFile(host, projectName, f.rel);
    if (content) {
      const localPath = join(localDir, f.rel);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, content);
      downloaded++;
      log("download", `  ${f.rel} (${(f.size / 1024).toFixed(1)}K)`);
    } else {
      log("download", `  FAIL ${f.rel}`);
    }
  }

  log("download", `Downloaded ${downloaded}/${resultFiles.length} result files → ${localDir}`);
  return downloaded;
}

// ── Grading ─────────────────────────────────────────────────────────────

async function runGrading(task, workDir, runDir) {
  log(task.taskId, "Running grading...");
  const rewrittenChecks = task.automatedChecks.replaceAll("/tmp_workspace", workDir);
  const gradeScript = `
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

${rewrittenChecks}

result = grade(transcript=[], workspace_path="${workDir.replace(/\\/g, "/")}")
print(json.dumps(result))
`.trim();

  const gradePath = join(runDir, "_grade.py");
  writeFileSync(gradePath, gradeScript);

  return new Promise((resolve) => {
    const proc = spawn("python3", [gradePath], {
      cwd: WCB_ROOT,
      timeout: 120_000,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        JUDGE_MODEL: process.env.JUDGE_MODEL || "openai/gpt-4.1-mini",
      },
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) {
        log(task.taskId, `Grading failed (exit ${code}): ${stderr.slice(0, 300)}`);
        const err = { error: `grade exit ${code}: ${stderr.slice(0, 200)}` };
        writeFileSync(join(runDir, "score.json"), JSON.stringify(err, null, 2));
        resolve(err);
        return;
      }
      try {
        let scores = null;
        for (const line of stdout.trim().split("\n").reverse()) {
          if (line.trim().startsWith("{")) {
            try { scores = JSON.parse(line.trim()); break; } catch {}
          }
        }
        if (!scores) throw new Error("No valid JSON in grade output");
        writeFileSync(join(runDir, "score.json"), JSON.stringify(scores, null, 2));
        log(task.taskId, `Grading done: ${JSON.stringify(scores)}`);
        resolve(scores);
      } catch (e) {
        const err = { error: `json parse: ${e.message}` };
        writeFileSync(join(runDir, "score.json"), JSON.stringify(err, null, 2));
        resolve(err);
      }
    });
  });
}

// ── Run Single Task ─────────────────────────────────────────────────────

async function runTask(task, args) {
  const host = args.host;
  const remoteWorkDir = `${REMOTE_BASE}/wcb_${task.taskId}`;
  const projectName = `home-liyishan-wcb_${task.taskId}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputBase = args.outputDir
    ? resolve(args.outputDir)
    : resolve(PILOTDECK_ROOT, "wcb-output", "remote_qwen36");
  const runDir = join(outputBase, task.category, task.taskId, `remote_${timestamp}`);
  mkdirSync(runDir, { recursive: true });

  log(task.taskId, `=== Starting remote task: ${task.taskId} ===`);
  log(task.taskId, `Remote workspace: ${remoteWorkDir}`);
  log(task.taskId, `Local output: ${runDir}`);

  const startTime = Date.now();

  // 1. Create remote workspace + project
  await api(host, "POST", "/api/create-folder", { path: remoteWorkDir });
  await api(host, "POST", "/api/create-folder", { path: `${remoteWorkDir}/results` });
  const createRes = await api(host, "POST", "/api/projects/create", { path: remoteWorkDir });
  log(task.taskId, `Project: ${createRes.project?.name || "exists"}`);

  // 2. Upload workspace files
  const uploadCount = await uploadWorkspace(host, projectName, task);
  const needsExtract = uploadCount === -1;

  // 3. Build prompt
  let prompt = task.prompt.replaceAll("/tmp_workspace", remoteWorkDir);
  const preamble = [];
  if (needsExtract) {
    const tarName = `wcb_upload_${task.taskId}.tar.gz`;
    preamble.push(
      `Before starting the task, extract the workspace archive:`,
      "```bash",
      `cd ${remoteWorkDir} && tar xzf ${tarName} && rm ${tarName}`,
      "```",
    );
  }
  if (task.warmup) {
    preamble.push(
      `First, install required dependencies by running:`,
      "```bash",
      `cd ${remoteWorkDir}`,
      task.warmup,
      "```",
    );
  }
  preamble.push(
    "CRITICAL: You are an autonomous AI agent. You MUST execute tools (bash, write_file, read_file, web_search) to complete the task. " +
    "Do NOT just describe what you would do. Execute commands NOW and produce ALL required output files in the results/ directory.",
  );
  prompt = preamble.join("\n") + "\n\n---\n\n" + prompt;

  log(task.taskId, `Prompt: ${prompt.length} chars`);

  // 4. Run agent via WebSocket
  const timeoutMs = Math.min(task.timeoutSeconds * 1000, args.timeoutMs);
  log(task.taskId, `Timeout: ${timeoutMs / 1000}s`);

  let wsResult;
  try {
    wsResult = await runAgentViaWebSocket(host, remoteWorkDir, prompt, timeoutMs);
  } catch (e) {
    log(task.taskId, `WebSocket error: ${e.message}`);
    wsResult = { events: [], timedOut: false, sessionId: null };
  }

  const elapsed = Date.now() - startTime;
  log(task.taskId, `Elapsed: ${(elapsed / 1000).toFixed(1)}s | Events: ${wsResult.events.length} | Timeout: ${wsResult.timedOut}`);

  // 5. Save events
  writeFileSync(join(runDir, "events.jsonl"),
    wsResult.events.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(runDir, "task-meta.json"), JSON.stringify({
    taskId: task.taskId,
    category: task.category,
    runner: "remote-pilotdeck",
    host,
    remoteWorkDir,
    startTime: new Date(startTime).toISOString(),
    elapsedMs: elapsed,
    timedOut: wsResult.timedOut,
    sessionId: wsResult.sessionId,
    eventCount: wsResult.events.length,
  }, null, 2));

  // 6. Download results from remote
  const localWorkDir = join(runDir, "workspace");
  mkdirSync(localWorkDir, { recursive: true });
  await downloadResults(host, projectName, localWorkDir);

  // 6b. Copy ground truth from local WCB source for grading
  const localGt = join(task.workspacePath, "gt");
  if (existsSync(localGt)) {
    const dstGt = join(localWorkDir, "gt");
    mkdirSync(dstGt, { recursive: true });
    for (const ent of readdirSync(localGt)) {
      const src = join(localGt, ent);
      if (statSync(src).isFile()) {
        writeFileSync(join(dstGt, ent), readFileSync(src));
      }
    }
    log(task.taskId, `Ground truth copied → ${dstGt}`);
  }

  // 7. Grading
  let scores = null;
  if (!args.skipGrading && task.automatedChecks) {
    scores = await runGrading(task, localWorkDir, runDir);
  }

  return { taskId: task.taskId, runDir, elapsed, timedOut: wsResult.timedOut, scores };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  let taskFiles = [];
  if (args.task) {
    taskFiles = [resolve(args.task)];
  } else {
    taskFiles = discoverTasks(args.category, args.filter, args.limit);
  }

  log("main", `Host: ${args.host}`);
  log("main", `Tasks: ${taskFiles.length}`);

  const results = [];
  for (const taskFile of taskFiles) {
    const task = await parseTaskMd(taskFile);
    try {
      const result = await runTask(task, args);
      results.push(result);
    } catch (e) {
      log(task.taskId, `FATAL: ${e.message}`);
      results.push({ taskId: task.taskId, error: e.message });
    }
    console.log("");
  }

  console.log("\n" + "=".repeat(60));
  console.log("  WCB-CC Remote PilotDeck Runner — Summary");
  console.log("=".repeat(60));
  for (const r of results) {
    const status = r.error ? "FAIL" : (r.timedOut ? "TIMEOUT" : "OK");
    const scoreStr = r.scores && !r.scores.error
      ? Object.entries(r.scores)
          .filter(([, v]) => typeof v === "number")
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(" ")
      : r.scores?.error ?? r.error ?? "n/a";
    console.log(`  [${status}] ${r.taskId}  ${((r.elapsed ?? 0) / 1000).toFixed(1)}s  ${scoreStr}`);
  }
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
