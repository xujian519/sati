import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getGlobalMcpConfigFilePath,
  getProjectMcpConfigFilePath,
  loadMcpServerConfig,
  MCP_CONFIG_FILE_NAME,
} from "../../../src/mcp/config/loadMcpServerConfig.js";

let root: string;

function setup() {
  root = mkdtempSync(join(tmpdir(), "sati-mcp-config-"));
  const pilotHome = join(root, "home");
  const projectRoot = join(root, "project");
  mkdirSync(pilotHome, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { pilotHome, projectRoot };
}

function teardown() {
  if (root) rmSync(root, { recursive: true, force: true });
}

test("config paths follow the expected layout", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    assert.equal(getGlobalMcpConfigFilePath(pilotHome), join(pilotHome, MCP_CONFIG_FILE_NAME));
    assert.equal(getProjectMcpConfigFilePath(projectRoot), join(projectRoot, ".sati", MCP_CONFIG_FILE_NAME));
  } finally {
    teardown();
  }
});

test("returns empty servers when no config file exists", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers, {});
    assert.deepEqual(result.diagnostics, []);
  } finally {
    teardown();
  }
});

test("reports a diagnostic for invalid JSON", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    writeFileSync(join(pilotHome, MCP_CONFIG_FILE_NAME), "{ not json");
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers, {});
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.path, join(pilotHome, MCP_CONFIG_FILE_NAME));
    assert.match(result.diagnostics[0]?.message ?? "", /JSON/i);
  } finally {
    teardown();
  }
});

test("reports a diagnostic when the config root is not an object", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    writeFileSync(join(pilotHome, MCP_CONFIG_FILE_NAME), "[1,2,3]");
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers, {});
    assert.match(result.diagnostics[0]?.message ?? "", /root must be an object/);
  } finally {
    teardown();
  }
});

test("reports a diagnostic when mcpServers is not an object", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    writeFileSync(join(pilotHome, MCP_CONFIG_FILE_NAME), JSON.stringify({ mcpServers: "nope" }));
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers, {});
    assert.match(result.diagnostics[0]?.message ?? "", /mcpServers must be an object/);
  } finally {
    teardown();
  }
});

test("merges global and project configs with the project winning", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    writeFileSync(
      join(pilotHome, MCP_CONFIG_FILE_NAME),
      JSON.stringify({
        mcpServers: {
          globalOnly: { command: "node", args: ["global.js"] },
          shared: { command: "node", args: ["global-shared.js"] },
        },
      }),
    );
    mkdirSync(join(projectRoot, ".sati"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".sati", MCP_CONFIG_FILE_NAME),
      JSON.stringify({
        mcpServers: {
          projectOnly: { url: "https://example.test/mcp" },
          shared: { command: "node", args: ["project-shared.js"] },
        },
      }),
    );
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(Object.keys(result.servers).sort(), ["globalOnly", "projectOnly", "shared"]);
    assert.deepEqual(
      (result.servers.shared as { args: string[] }).args,
      ["project-shared.js"],
      "project entry must override the global one",
    );
    assert.deepEqual(result.diagnostics, []);
  } finally {
    teardown();
  }
});

test("expands placeholders in server specs", () => {
  const { pilotHome, projectRoot } = setup();
  process.env.SATI_MCP_TEST_TOKEN = "tok123";
  try {
    writeFileSync(
      join(pilotHome, MCP_CONFIG_FILE_NAME),
      JSON.stringify({
        mcpServers: {
          auth: {
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer ${env:SATI_MCP_TEST_TOKEN}" },
          },
        },
      }),
    );
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers.auth, {
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer tok123" },
    });
  } finally {
    delete process.env.SATI_MCP_TEST_TOKEN;
    teardown();
  }
});

test("an empty mcpServers object yields no servers", () => {
  const { pilotHome, projectRoot } = setup();
  try {
    writeFileSync(join(pilotHome, MCP_CONFIG_FILE_NAME), JSON.stringify({ mcpServers: {} }));
    const result = loadMcpServerConfig(projectRoot, pilotHome);
    assert.deepEqual(result.servers, {});
    assert.deepEqual(result.diagnostics, []);
  } finally {
    teardown();
  }
});
