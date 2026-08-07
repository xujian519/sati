import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDefaultSatiConfig,
  readSatiConfigFile,
  sanitizeProviderCredentials,
  validateSatiConfig,
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
});
