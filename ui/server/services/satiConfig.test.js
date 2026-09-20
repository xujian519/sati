import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDefaultSatiConfig,
  configRevision,
  guardPatentDomainTriState,
  readSatiConfigFile,
  resolveModel,
  sanitizeProviderCredentials,
  validateSatiConfig,
  writeSatiConfig,
} from "./satiConfig.js";

const tempDirs = [];

afterEach(() => {
  delete process.env.SATI_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function useTempConfig(contents, filename = "sati.yaml") {
  const dir = mkdtempSync(join(tmpdir(), "sati-config-test-"));
  tempDirs.push(dir);
  const configPath = join(dir, filename);
  if (contents !== null) {
    writeFileSync(configPath, contents, "utf8");
  }
  process.env.SATI_CONFIG_PATH = configPath;
  return configPath;
}

describe("readSatiConfigFile fallback behavior", () => {
  it("uses built-in Office preview by default", () => {
    expect(buildDefaultSatiConfig().webui.officePreview).toEqual({
      service: "builtin",
      binaryPath: "",
    });
  });

  it("returns defaults when the config file is missing", () => {
    const configPath = useTempConfig(null);

    const record = readSatiConfigFile();

    expect(record.exists).toBe(false);
    expect(record.configPath).toBe(configPath);
    expect(record.raw).toBe("");
    expect(record.rawYaml).toEqual({});
    expect(record.parseError).toBeNull();
    expect(record.config.schemaVersion).toBe(1);
    expect(record.config.webui.officePreview.service).toBe("builtin");
  });

  it("reads and normalizes valid YAML", () => {
    useTempConfig("schemaVersion: 1\nmodel:\n  providers: {}\n");

    const record = readSatiConfigFile();

    expect(record.exists).toBe(true);
    expect(record.parseError).toBeNull();
    expect(record.rawYaml).toMatchObject({ schemaVersion: 1, model: { providers: {} } });
    expect(record.config.model.providers).toEqual({});
    expect(record.config.memory.enabled).toBe(true);
  });

  it("keeps raw YAML and falls back to defaults when YAML is invalid", () => {
    const raw = "schemaVersion: 1\nmodel:\n  providers: [\n";
    useTempConfig(raw);

    const record = readSatiConfigFile();

    expect(record.exists).toBe(true);
    expect(record.raw).toBe(raw);
    expect(record.rawYaml).toBeNull();
    expect(record.parseError).toEqual(expect.any(String));
    expect(record.config.schemaVersion).toBe(1);
    expect(record.config.model.providers).toEqual({});
  });
});

describe("optional feature defaults（上游 #588）", () => {
  it("新用户默认：router 与两个搜索工具关，memory 保持开", () => {
    const defaults = buildDefaultSatiConfig();

    expect(defaults.router.enabled).toBe(false);
    expect(defaults.tools.webSearch.enabled).toBe(false);
    expect(defaults.tools.paperSearch.enabled).toBe(false);
    // memory 刻意不随本批翻转：翻转会停掉记忆索引调度器
    expect(defaults.memory.enabled).toBe(true);
  });

  it("无配置文件时读到的归一配置也是「可选功能关闭」", () => {
    useTempConfig(null);

    const { config } = readSatiConfigFile();

    expect(config.router).toEqual({ enabled: false });
    expect(config.tools.webSearch.enabled).toBe(false);
    expect(config.tools.paperSearch.enabled).toBe(false);
    expect(config.memory.enabled).toBe(true);
  });

  it("遗留守卫：段存在但无 enabled 的配置，归一后判为开启", () => {
    useTempConfig(
      [
        "agent:",
        "  model: openai/gpt-4o-mini",
        "model:",
        "  providers:",
        "    openai:",
        "      protocol: openai",
        "      url: https://api.openai.com/v1",
        "      apiKey: sk-test-legacy",
        "      models:",
        "        gpt-4o-mini: {}",
        "router:",
        "  scenarios:",
        "    default: openai/gpt-4o-mini",
        "tools:",
        "  webSearch:",
        "    provider: tavily",
        "  paperSearch:",
        "    arxiv: true",
        "",
      ].join("\n"),
    );

    const { config } = readSatiConfigFile();

    expect(config.router.enabled).toBe(true);
    expect(config.tools.webSearch.enabled).toBe(true);
    expect(config.tools.paperSearch.enabled).toBe(true);
  });

  it("三态守卫：默认值注入不得冻结 patentDomain（#450）", () => {
    // 模拟"默认配置将来注入了一个值"：守卫必须把未声明的缺省态还原成缺省。
    const normalized = { tools: { webSearch: { enabled: false }, patentDomain: false } };
    guardPatentDomainTriState({ tools: { webSearch: {} } }, normalized);
    expect("patentDomain" in normalized.tools).toBe(false);
    // 用户显式写过的值原样保留（两个方向）。
    const kept = { tools: { patentDomain: true } };
    guardPatentDomainTriState({ tools: { patentDomain: true } }, kept);
    expect(kept.tools.patentDomain).toBe(true);
  });

  it("三态守卫的关键后果：读取→保存往返不得冻结「自动」，读取后配置里也没有该键", async () => {
    const configPath = useTempConfig(
      [
        "agent:",
        "  model: openai/gpt-4o-mini",
        "model:",
        "  providers:",
        "    openai:",
        "      protocol: openai",
        "      url: https://api.openai.com/v1",
        "      apiKey: sk-test-tristate",
        "      models:",
        "        gpt-4o-mini: {}",
        "tools:",
        "  webSearch:",
        "    enabled: true",
        "",
      ].join("\n"),
    );

    const { config } = readSatiConfigFile();
    expect("patentDomain" in config.tools).toBe(false);

    await writeSatiConfig(config);
    const raw = readFileSync(configPath, "utf8");
    expect(raw.includes("patentDomain")).toBe(false);

    // 用户显式选择"始终开启"后，往返必须保住它。
    config.tools.patentDomain = true;
    await writeSatiConfig(config);
    const reopened = readSatiConfigFile().config;
    expect(reopened.tools.patentDomain).toBe(true);
  });

  it("遗留守卫的关键后果：读取→保存往返不得把既有功能静默关闭", async () => {
    const configPath = useTempConfig(
      [
        "agent:",
        "  model: openai/gpt-4o-mini",
        "model:",
        "  providers:",
        "    openai:",
        "      protocol: openai",
        "      url: https://api.openai.com/v1",
        "      apiKey: sk-test-legacy",
        "      models:",
        "        gpt-4o-mini: {}",
        "router:",
        "  scenarios:",
        "    default: openai/gpt-4o-mini",
        "tools:",
        "  webSearch:",
        "    provider: tavily",
        "  paperSearch:",
        "    arxiv: true",
        "",
      ].join("\n"),
    );

    // 模拟 UI：读到归一配置 → 原样写回
    await writeSatiConfig(readSatiConfigFile().config);

    const written = readFileSync(configPath, "utf8");
    expect(written).toMatch(/router:\n\s+enabled: true/);
    expect(written).toMatch(/webSearch:\n\s+[^\n]*enabled: true/);
    expect(written).toMatch(/paperSearch:\n\s+enabled: true/);
    // 兄弟段（paperSearch 的连接器选择）没被写丢
    expect(written).toContain("arxiv: true");
  });

  it("显式 enabled 值优先，且归一幂等", async () => {
    const configPath = useTempConfig(
      [
        "agent:",
        "  model: openai/gpt-4o-mini",
        "model:",
        "  providers:",
        "    openai:",
        "      protocol: openai",
        "      url: https://api.openai.com/v1",
        "      apiKey: sk-test-legacy",
        "      models:",
        "        gpt-4o-mini: {}",
        "router:",
        "  enabled: true",
        "tools:",
        "  webSearch:",
        "    enabled: true",
        "    provider: tavily",
        "  paperSearch:",
        "    enabled: false",
        "",
      ].join("\n"),
    );

    await writeSatiConfig(readSatiConfigFile().config);
    const first = readFileSync(configPath, "utf8");
    await writeSatiConfig(readSatiConfigFile().config);

    expect(readFileSync(configPath, "utf8")).toBe(first);
    const { config } = readSatiConfigFile();
    expect(config.router.enabled).toBe(true);
    expect(config.tools.webSearch.enabled).toBe(true);
    expect(config.tools.paperSearch.enabled).toBe(false);
  });
});

describe("validateSatiConfig gateway validation", () => {
  it("migrates the legacy interactive spreadsheet mode to built-in preview", () => {
    const validation = validateSatiConfig({
      webui: {
        officePreview: {
          service: "libreoffice",
          spreadsheetMode: "auto",
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.config.webui.officePreview).toEqual({
      service: "builtin",
      binaryPath: "",
    });
  });

  it("migrates the legacy print spreadsheet mode to LibreOffice preview", () => {
    const validation = validateSatiConfig({
      webui: {
        officePreview: {
          service: "libreoffice",
          spreadsheetMode: "print",
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.config.webui.officePreview).toEqual({
      service: "libreoffice",
      binaryPath: "",
    });
  });

  it("migrates the legacy disabled Office service to built-in preview", () => {
    const validation = validateSatiConfig({
      webui: {
        officePreview: {
          service: "none",
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.config.webui.officePreview.service).toBe("builtin");
  });

  it("rejects unsupported Office preview services", () => {
    const validation = validateSatiConfig({
      webui: {
        officePreview: {
          service: "unexpected",
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('webui.officePreview.service must be "builtin" or "libreoffice"');
  });

  it("rejects non-object gateway config", () => {
    const validation = validateSatiConfig({ gateway: true });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("gateway: gateway config must be an object.");
  });

  it("rejects unsupported gateway bindAddress", () => {
    const validation = validateSatiConfig({
      gateway: {
        bindAddress: "0.0.0.0",
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "gateway.bindAddress: gateway.bindAddress must be 127.0.0.1 in the first phase.",
    );
  });

  it("warns when gateway.tokenPath is configured", () => {
    const validation = validateSatiConfig({
      gateway: {
        tokenPath: "/tmp/token",
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain(
      "gateway.tokenPath: gateway.tokenPath is no longer configurable; the gateway token is stored under PilotHome.",
    );
  });

  it("accepts valid gateway config", () => {
    const validation = validateSatiConfig({
      gateway: {
        bindAddress: "127.0.0.1",
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("accepts Ollama providers without an apiKey", () => {
    const validation = validateSatiConfig({
      agent: { model: "ollama/qwen3:0.6b" },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("removes blank Ollama apiKeys during sanitization", () => {
    const config = sanitizeProviderCredentials({
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: " http://localhost:11434/v1 ",
            apiKey: "   ",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(config.model.providers.ollama).not.toHaveProperty("apiKey");
    expect(config.model.providers.ollama.url).toBe("http://localhost:11434/v1");
  });

  it("rejects an unreferenced provider stub missing url and apiKey", () => {
    const validation = validateSatiConfig({
      agent: { model: "deepseek/deepseek-v4-flash" },
      model: {
        providers: {
          deepseek: {
            protocol: "openai",
            url: "https://api.deepseek.com/v1",
            apiKey: "sk-test",
            models: { "deepseek-v4-flash": {} },
          },
          provider1: {
            protocol: "openai",
            url: "",
            apiKey: "",
            models: {},
          },
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("model.providers.provider1.url is required");
    expect(validation.errors).toContain("model.providers.provider1.apiKey is required");
  });

  it("accepts null model definitions as empty objects", () => {
    const validation = validateSatiConfig({
      agent: { model: "ollama/qwen3:0.6b" },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": null,
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.config.model.providers.ollama.models["qwen3:0.6b"]).toBeNull();
    expect(resolveModel(validation.config, "ollama/qwen3:0.6b").def).toEqual({});
  });

  it("still treats absent model keys as missing", () => {
    const validation = validateSatiConfig({
      agent: { model: "ollama/missing-model" },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": null,
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      'agent.model="ollama/missing-model" doesn\'t resolve to a configured provider/model',
    );
  });

  it("still rejects non-object model definitions", () => {
    expect(() =>
      resolveModel(
        {
          agent: { model: "ollama/qwen3:0.6b" },
          model: {
            providers: {
              ollama: {
                protocol: "openai",
                url: "http://localhost:11434/v1",
                models: {
                  "qwen3:0.6b": "invalid",
                },
              },
            },
          },
        },
        "ollama/qwen3:0.6b",
      ),
    ).toThrow('Model definition for provider "ollama" must be an object: qwen3:0.6b');
  });

  it("warns instead of failing when agent.subagents.default references a missing provider", () => {
    const validation = validateSatiConfig({
      agent: {
        model: "ollama/qwen3:0.6b",
        subagents: { default: "missing/qwen3:0.6b" },
      },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain(
      'agent.subagents.default="missing/qwen3:0.6b" doesn\'t resolve to a configured provider/model; subagents will inherit agent.model',
    );
  });

  it("warns instead of failing when agent.subagents.default references a missing model", () => {
    const validation = validateSatiConfig({
      agent: {
        model: "ollama/qwen3:0.6b",
        subagents: { default: "ollama/missing-model" },
      },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain(
      'agent.subagents.default="ollama/missing-model" doesn\'t resolve to a configured provider/model; subagents will inherit agent.model',
    );
  });

  it("rejects agent.model when the configured model is missing", () => {
    const validation = validateSatiConfig({
      agent: { model: "ollama/missing-model" },
      model: {
        providers: {
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      'agent.model="ollama/missing-model" doesn\'t resolve to a configured provider/model',
    );
  });

  it("resets a placeholder subagent default when writing config", async () => {
    const configPath = useTempConfig(null);

    const result = await writeSatiConfig({
      agent: {
        model: "ollama/qwen3:0.6b",
        subagents: { default: "_placeholder/_placeholder" },
      },
      model: {
        providers: {
          _placeholder: {
            protocol: "openai",
            url: "https://example.invalid/v1",
            apiKey: "PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE",
            models: {
              _placeholder: {},
            },
          },
          ollama: {
            protocol: "openai",
            url: "http://localhost:11434/v1",
            models: {
              "qwen3:0.6b": {},
            },
          },
        },
      },
    });

    expect(result.config.agent.subagents.default).toBe("inherit");
    expect(result.config.model.providers).not.toHaveProperty("_placeholder");
    expect(result.configPath).toBe(configPath);
  });
});

describe("writeSatiConfig transactional save", () => {
  function validConfig(tag) {
    return {
      agent: { model: "openai/gpt-4o-mini" },
      model: {
        providers: {
          openai: {
            protocol: "openai",
            url: "https://api.openai.com/v1",
            apiKey: `sk-test-${tag}`,
            models: { "gpt-4o-mini": {} },
          },
        },
      },
    };
  }

  it("writes atomically and leaves no temp file behind", () => {
    const configPath = useTempConfig(null);

    return writeSatiConfig(validConfig("a")).then(() => {
      const record = readSatiConfigFile();
      expect(record.parseError).toBeNull();
      expect(existsSync(`${configPath}.sati-tmp`)).toBe(false);
      expect(readFileSync(configPath, "utf8")).toBe(record.raw);
    });
  });

  it("serializes concurrent writes: the file is always one writer's complete output", async () => {
    useTempConfig(null);
    const tags = ["one", "two", "three"];
    await Promise.all(tags.map(tag => writeSatiConfig(validConfig(tag))));

    const record = readSatiConfigFile();
    expect(record.parseError).toBeNull();
    const apiKey = record.config.model.providers.openai.apiKey;
    expect(tags).toContain(apiKey.replace("sk-test-", ""));
  });

  it("keeps the previous config intact when the temp write fails", async () => {
    const configPath = useTempConfig(null);
    await writeSatiConfig(validConfig("keep"));
    const before = readFileSync(configPath, "utf8");

    await chmodSync(join(configPath, ".."), 0o555);
    try {
      await expect(writeSatiConfig(validConfig("blocked"))).rejects.toThrow();
    } finally {
      await chmodSync(join(configPath, ".."), 0o755);
    }

    // 原子写失败后磁盘仍是完整的旧配置，且无 temp 残留。
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(`${configPath}.sati-tmp`)).toBe(false);
  });

  it("enforces the optimistic lock via previousRevision", async () => {
    useTempConfig(null);
    await writeSatiConfig(validConfig("v1"));
    const revision = configRevision(readSatiConfigFile().raw);

    const outcome = await writeSatiConfig(validConfig("stale"), { previousRevision: "deadbeef" }).then(
      () => "resolved",
      error => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.code).toBe("CONFIG_CONFLICT");
    expect(outcome.currentRevision).toHaveLength(64);
    // 冲突写被拒绝后磁盘仍是 v1。
    expect(readSatiConfigFile().config.model.providers.openai.apiKey).toBe("sk-test-v1");

    await expect(writeSatiConfig(validConfig("v2"), { previousRevision: revision })).resolves.toBeTruthy();
    expect(readSatiConfigFile().config.model.providers.openai.apiKey).toBe("sk-test-v2");
  });
});
