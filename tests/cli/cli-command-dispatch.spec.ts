/**
 * `sati` 分发表（P2.7）行为锚。
 *
 * 钉住三件事：
 *   1. `COMMANDS` 键集固定——新增/删除子命令必须同步本测试与 `--help`；
 *   2. `--help` 里列出的每个子命令都真的可分发（帮助文本 ↔ 分发表不漂移）；
 *   3. `resolveCommand` 只认真实键：原型链上的 `toString` / `constructor` / `__proto__`
 *      必须未命中（否则这些参数名会落进子命令分支而不是交互式 CLI）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, main, printUsage, resolveCommand } from "../../src/cli/commandDispatch.js";
import { APP_VERSION } from "../../src/version.js";

const TABLE_COMMANDS = [
  "browsers",
  "chat",
  "config",
  "cron",
  "gateway",
  "hooks",
  "patent-search",
  "server",
  "skills",
  "tui",
  "update",
];

/**
 * `--help` 的 Commands 段列出的子命令。比 `TABLE_COMMANDS` 少 `patent-search`
 * ——历史遗漏（该命令可用但未在帮助里出现），P2.7 有意不动帮助文本。
 */
const HELP_COMMANDS = TABLE_COMMANDS.filter(name => name !== "patent-search");

function captureUsage(): string {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    printUsage();
  } finally {
    console.log = original;
  }
  return captured.join("\n");
}

/** 从帮助文本的 Commands 段提取子命令名（跳过 `(none)` 与 Options 段）。 */
function helpCommandNames(usage: string): string[] {
  const lines = usage.split("\n");
  const start = lines.findIndex(line => line.trim() === "Commands:");
  assert.ok(start >= 0, "帮助文本应含 Commands 段");
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Options:") break;
    const token = trimmed.split(/\s+/)[0];
    if (token && token !== "(none)") names.push(token);
  }
  return [...new Set(names)].sort();
}

test("分发表键集固定，且每个值都是函数", () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), TABLE_COMMANDS);
  for (const [name, handler] of Object.entries(COMMANDS)) {
    assert.equal(typeof handler, "function", `${name} 必须是函数`);
  }
});

test("--help 列出的子命令都在分发表里（帮助 ↔ 分发表不漂移）", () => {
  assert.deepEqual(helpCommandNames(captureUsage()), HELP_COMMANDS);
  for (const name of HELP_COMMANDS) {
    assert.ok(resolveCommand(name), `--help 里的 ${name} 应可分发`);
  }
});

test("resolveCommand 命中真实键、放过未知键与原型链键", () => {
  assert.equal(resolveCommand("server"), COMMANDS.server);
  assert.equal(resolveCommand("patent-search"), COMMANDS["patent-search"]);
  assert.equal(resolveCommand(undefined), undefined);
  assert.equal(resolveCommand(""), undefined);
  assert.equal(resolveCommand("--help"), undefined);
  assert.equal(resolveCommand("no-such-command"), undefined);
  for (const inherited of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
    assert.equal(resolveCommand(inherited), undefined, `${inherited} 不得命中分发表`);
  }
});

test("--version / -v 打印版本且不进入任何子命令", async () => {
  for (const flag of ["--version", "-v"]) {
    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await main([flag]);
    } finally {
      console.log = original;
    }
    assert.equal(captured.join("\n"), APP_VERSION);
  }
});

test("--help / -h / help 打印用法（含 Usage 与 Options 段）", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await main([flag]);
    } finally {
      console.log = original;
    }
    const usage = captured.join("\n");
    assert.match(usage, /^sati v[\d.]+ — AI agent runtime/);
    assert.match(usage, /Usage: sati \[command\] \[options\]/);
    assert.match(usage, /\nOptions:/);
  }
});
