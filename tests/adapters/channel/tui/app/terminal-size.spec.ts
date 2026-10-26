import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { readTerminalSize } from "../../../../../src/adapters/channel/tui/app/terminal-size.js";

test("readTerminalSize: 终端流读出 columns/rows", () => {
  const stream = Object.assign(new Writable(), { columns: 120, rows: 40 });
  assert.deepEqual(readTerminalSize(stream), { columns: 120, rows: 40 });
});

test("readTerminalSize: 非 TTY 流无尺寸属性时返回 undefined，交调用方兜底", () => {
  assert.deepEqual(readTerminalSize(new Writable()), { columns: undefined, rows: undefined });
});

test("readTerminalSize: 无 stdout 时返回 undefined", () => {
  assert.deepEqual(readTerminalSize(undefined), { columns: undefined, rows: undefined });
});
