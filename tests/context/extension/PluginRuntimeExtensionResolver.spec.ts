import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginRuntimeExtensionResolver,
  type PluginRuntimeLike,
} from "../../../src/context/extension/PluginRuntimeExtensionResolver.js";

function makeRuntime(overrides: Partial<PluginRuntimeLike> = {}): PluginRuntimeLike {
  return {
    snapshot: () => [],
    ...overrides,
  };
}

test("listMcpInstructions merges static plugin and runtime-fetched instructions", () => {
  const resolver = new PluginRuntimeExtensionResolver(
    makeRuntime({
      getAllMcpInstructions: () => [
        { serverName: "static-server", instructions: "static guidance" },
        { serverName: "both", instructions: "static for both" },
      ],
    }),
    {
      runtimeMcpInstructions: () => [
        { serverId: "live-server", instructions: "live guidance" },
        { serverId: "both", instructions: "live for both" },
      ],
    },
  );
  assert.deepEqual(resolver.listMcpInstructions(), [
    { serverName: "static-server", instructions: "static guidance" },
    { serverName: "both", instructions: "static for both" },
    { serverName: "live-server", instructions: "live guidance" },
    { serverName: "both", instructions: "live for both" },
  ]);
});

test("listMcpInstructions works with only runtime instructions", () => {
  const resolver = new PluginRuntimeExtensionResolver(makeRuntime(), {
    runtimeMcpInstructions: () => [{ serverId: "live", instructions: "hello" }],
  });
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "live", instructions: "hello" }]);
});

test("listMcpInstructions works with only static instructions", () => {
  const resolver = new PluginRuntimeExtensionResolver(
    makeRuntime({
      getAllMcpInstructions: () => [{ serverName: "static", instructions: "hi" }],
    }),
  );
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "static", instructions: "hi" }]);
});

test("listMcpInstructions returns an empty list when neither source exists", () => {
  const resolver = new PluginRuntimeExtensionResolver(makeRuntime());
  assert.deepEqual(resolver.listMcpInstructions(), []);
});

test("listMcpInstructions is stable when the runtime method returns no entries", () => {
  const resolver = new PluginRuntimeExtensionResolver(
    makeRuntime({
      getAllMcpInstructions: () => [{ serverName: "static", instructions: "hi" }],
    }),
    { runtimeMcpInstructions: () => [] },
  );
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "static", instructions: "hi" }]);
});
