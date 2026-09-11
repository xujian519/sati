import { describe, expect, it } from "vitest";
import { patch } from "./patch";

describe("patch (deep immutable set)", () => {
  it("sets a nested object field without mutating the source", () => {
    const config = { memory: { enabled: true, autoIndexIntervalMinutes: 10 } };

    const updated = patch(config, ["memory", "autoIndexIntervalMinutes"], 30);

    expect(updated.memory?.autoIndexIntervalMinutes).toBe(30);
    expect(config.memory.autoIndexIntervalMinutes).toBe(10);
    expect(updated).not.toBe(config);
    expect(updated.memory).not.toBe(config.memory);
  });

  it("creates missing intermediate containers from the path segment types", () => {
    const updated = patch({}, ["model", "providers", "main", "models"], { "m-1": {} });

    expect(updated).toEqual({ model: { providers: { main: { models: { "m-1": {} } } } } });
  });

  it("rebuilds arrays by index and keeps sibling entries", () => {
    const config = { routes: ["a", "b", "c"] };

    const updated = patch(config, ["routes", 1], "B");

    expect(updated.routes).toEqual(["a", "B", "c"]);
    expect(config.routes).toEqual(["a", "b", "c"]);
    expect(Array.isArray(updated.routes)).toBe(true);
  });

  it("falls back to an empty container for a null source", () => {
    expect(patch(null, ["memory", "enabled"], true)).toEqual({ memory: { enabled: true } });
    expect(patch(undefined, ["routes", 0], "a")).toEqual({ routes: ["a"] });
  });

  it("returns the value itself for an empty path", () => {
    expect(patch({ a: 1 }, [], "replaced")).toBe("replaced");
  });
});
