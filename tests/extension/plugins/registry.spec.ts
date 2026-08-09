import test from "node:test";
import assert from "node:assert/strict";
import { PluginRegistry } from "../../../src/extension/plugins/runtime/PluginRegistry.js";
import { HookExecutionEventBus } from "../../../src/extension/hooks/events/HookExecutionEventBus.js";
import { discoverBuiltinPlugins } from "../../../src/extension/plugins/discovery/discoverBuiltinPlugins.js";
import type { SatiLoadedPlugin } from "../../../src/extension/plugins/protocol/plugin.js";

function loadedPlugin(name: string, source: string): SatiLoadedPlugin {
  return { name, source } as SatiLoadedPlugin;
}

test("PluginRegistry.replaceAll is wholesale replacement keyed by name@source", () => {
  const registry = new PluginRegistry();
  registry.replaceAll([loadedPlugin("a", "builtin"), loadedPlugin("b", "project")]);
  assert.deepEqual(
    registry
      .list()
      .map(p => p.name)
      .sort(),
    ["a", "b"],
  );
  registry.replaceAll([loadedPlugin("a", "project")]); // replaces the whole set
  assert.deepEqual(
    registry.list().map(p => `${p.name}@${p.source}`),
    ["a@project"],
  );
});

test("PluginRegistry keeps same-name different-source entries within one batch", () => {
  const registry = new PluginRegistry();
  registry.replaceAll([loadedPlugin("a", "builtin"), loadedPlugin("a", "project")]);
  assert.deepEqual(
    registry
      .list()
      .map(p => `${p.name}@${p.source}`)
      .sort(),
    ["a@builtin", "a@project"],
  );
});

test("PluginRegistry.replaceAll clears entries not in the new set", () => {
  const registry = new PluginRegistry();
  registry.replaceAll([loadedPlugin("a", "builtin"), loadedPlugin("b", "builtin")]);
  registry.replaceAll([loadedPlugin("a", "builtin")]);
  assert.deepEqual(
    registry.list().map(p => p.name),
    ["a"],
  );
});

test("HookExecutionEventBus subscribes, emits and unsubscribes", () => {
  const bus = new HookExecutionEventBus();
  const received: unknown[] = [];
  const unsubscribe = bus.subscribe(event => received.push(event));
  bus.emit({ type: "started", hookName: "h", hookEvent: "PreToolUse" });
  assert.equal(received.length, 1);
  unsubscribe();
  bus.emit({ type: "started", hookName: "h2", hookEvent: "PostToolUse" });
  assert.equal(received.length, 1);
});

test("HookExecutionEventBus supports multiple subscribers", () => {
  const bus = new HookExecutionEventBus();
  let first = 0;
  let second = 0;
  bus.subscribe(() => (first += 1));
  bus.subscribe(() => (second += 1));
  bus.emit({ type: "response", hookName: "h", hookEvent: "PreToolUse", stdout: "", stderr: "", outcome: "success" });
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test("discoverBuiltinPlugins filters to builtin source only", () => {
  const plugins = [loadedPlugin("a", "builtin"), loadedPlugin("b", "project"), loadedPlugin("c", "builtin")];
  const builtin = discoverBuiltinPlugins(plugins);
  assert.deepEqual(
    builtin.map(p => p.name),
    ["a", "c"],
  );
  assert.deepEqual(discoverBuiltinPlugins(), []);
});
