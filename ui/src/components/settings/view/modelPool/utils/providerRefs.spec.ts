import { describe, expect, it } from "vitest";
import type { SatiConfig } from "../types";
import { clearSubagentDefaultForRemovedModel, clearSubagentDefaultForRemovedProvider } from "./providerRefs";

describe("subagent default model reference cleanup", () => {
  it("resets agent.subagents.default when its provider is removed", () => {
    const config: SatiConfig = {
      agent: {
        model: "main/main-model",
        subagents: { default: "child/child-model" },
      },
      model: {
        providers: {
          main: { models: { "main-model": {} } },
        },
      },
    };

    const updated = clearSubagentDefaultForRemovedProvider(config, "child");

    expect(updated.agent?.subagents?.default).toBe("inherit");
    expect(config.agent?.subagents?.default).toBe("child/child-model");
  });

  it("keeps agent.subagents.default when a different provider is removed", () => {
    const config: SatiConfig = {
      agent: {
        model: "main/main-model",
        subagents: { default: "child/child-model" },
      },
    };

    const updated = clearSubagentDefaultForRemovedProvider(config, "main");

    expect(updated).toBe(config);
  });

  it("resets agent.subagents.default when its model is removed", () => {
    const config: SatiConfig = {
      agent: {
        model: "main/main-model",
        subagents: { default: "child/child-model" },
      },
      model: {
        providers: {
          child: { models: {} },
        },
      },
    };

    const updated = clearSubagentDefaultForRemovedModel(config, "child", "child-model");

    expect(updated.agent?.subagents?.default).toBe("inherit");
  });

  it("keeps agent.subagents.default when a different model is removed", () => {
    const config: SatiConfig = {
      agent: {
        model: "main/main-model",
        subagents: { default: "child/child-model" },
      },
    };

    const updated = clearSubagentDefaultForRemovedModel(config, "child", "other-model");

    expect(updated).toBe(config);
  });
});
