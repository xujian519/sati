/**
 * Pilot 配置校验错误的通道一致性测试（#347 / TD-PILOT-N02）。
 *
 * 债务：值校验器以 `throw PilotConfigError` 表达 fatal，而它不往诊断数组里写。
 * 异常冒泡后 `error.diagnostics` 为空，`PilotConfigStore.getDiagnostics()` 因此
 * 丢掉失败原因（「诊断为空 ⇔ 配置没问题」这条契约被破坏）。
 *
 * 本文件锁定两件事：
 * 1. 端到端：走裸 throw 的配置错误，其 `error.diagnostics` 非空，且 reload 后
 *    `store.getDiagnostics()` 能读到失败原因；
 * 2. 单位级：`configFailureDiagnostics` 对三种输入形态的转写结果。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configFailureDiagnostics, loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { createPilotConfigStoreSync } from "../../../src/pilot/config/PilotConfigStore.js";
import { PilotConfigError, type PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import { PILOT_CONFIG_FILE_NAME } from "../../../src/pilot/paths.js";

const AGENT_HEAD = ["schemaVersion: 1", "agent:", "  model: deepseek/deepseek-chat"];
const MODEL_TAIL = [
  "model:",
  "  providers:",
  "    deepseek:",
  "      protocol: openai",
  "      url: https://api.deepseek.com/v1",
  "      apiKey: sk-test",
  "      models:",
  "        deepseek-chat:",
  "          id: deepseek-chat",
];

/** 拼一份「除被测字段外均合法」的 sati.yaml。 */
function yamlWith(agentLines: string[] = [], memoryLines: string[] = []): string {
  return [...AGENT_HEAD, ...agentLines, ...MODEL_TAIL, ...memoryLines].join("\n") + "\n";
}

/**
 * 每条用例的 `agentLines` / `memoryLines` 都必须触发**值校验器的裸 throw**
 * （`readOptionalPositiveInteger` / `readString` / `readBoolean` / parseStringArray 一族），
 * 而不是走 `diagnostics.push` 的既有通道——后者本来就正常，不构成本测试的目标。
 */
const ESCAPED_THROW_CASES: Array<{ name: string; agentLines?: string[]; memoryLines?: string[] }> = [
  { name: "agent.maxContextTokens 非正数（readOptionalPositiveInteger）", agentLines: ["  maxContextTokens: -5"] },
  { name: "agent.subagents 非对象（parseAgentSubagents）", agentLines: ["  subagents: 3"] },
  {
    name: "memory.embedding 缺 provider/baseUrl（parseMemoryEmbeddingConfig）",
    memoryLines: ["memory:", "  embedding:", "    model: m"],
  },
  {
    name: "memory.knowledgeProfile 非对象（parseKnowledgeProfile）",
    memoryLines: ["memory:", "  knowledgeProfile: 7"],
  },
  { name: "memory.captureStrategy 非法（readCaptureStrategy）", memoryLines: ["memory:", "  captureStrategy: nope"] },
];

test("裸 throw 的校验错误也带诊断：error.diagnostics 非空且含 fatal 项", async () => {
  for (const testCase of ESCAPED_THROW_CASES) {
    // 配置路径由 SATI_HOME 推导，故每个用例独占一个临时 HOME。
    const dir = await mkdtemp(join(tmpdir(), "sati-pilot-channel-"));
    try {
      await writeFile(join(dir, PILOT_CONFIG_FILE_NAME), yamlWith(testCase.agentLines, testCase.memoryLines), "utf8");

      let thrown: unknown;
      try {
        loadPilotConfig({ env: { SATI_HOME: dir, DEEPSEEK_API_KEY: "sk-test" } });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown instanceof PilotConfigError, `${testCase.name}: 应抛 PilotConfigError`);
      assert.ok(thrown.diagnostics.length > 0, `${testCase.name}: error.diagnostics 不应为空（这正是 #347 的缺陷）`);
      assert.ok(
        thrown.diagnostics.some(diagnostic => diagnostic.severity === "fatal"),
        `${testCase.name}: 诊断中应含 fatal 项`,
      );
      // 兜住后对外可见的 code / message 必须与裸 throw 一致，否则是行为漂移。
      assert.ok(
        thrown.diagnostics.some(diagnostic => diagnostic.code === thrown.code && diagnostic.message === thrown.message),
        `${testCase.name}: error.code/message 应能在诊断数组中原样找到`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("reload 失败后 getDiagnostics() 能读到失败原因（端到端）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-pilot-channel-store-"));
  try {
    const configPath = join(dir, PILOT_CONFIG_FILE_NAME);
    await writeFile(configPath, yamlWith(), "utf8");
    const store = createPilotConfigStoreSync({ env: { SATI_HOME: dir, DEEPSEEK_API_KEY: "sk-test" } });
    assert.deepEqual(store.getDiagnostics(), []);

    // 改成「agent.maxContextTokens 非正数」——走裸 throw 通道。
    await writeFile(configPath, yamlWith(["  maxContextTokens: -5"]), "utf8");
    await assert.rejects(() => store.reload("test"), PilotConfigError);

    const diagnostics: PilotConfigDiagnostic[] = store.getDiagnostics();
    assert.ok(
      diagnostics.some(
        diagnostic => diagnostic.code === "CONFIG_INVALID_VALUE" && diagnostic.message.includes("maxContextTokens"),
      ),
      `getDiagnostics() 应包含 maxContextTokens 的失败原因，实际为 ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configFailureDiagnostics：已携带诊断的错误原样透出", () => {
  const existing: PilotConfigDiagnostic[] = [
    { code: "CONFIG_AGENT_MISSING", severity: "fatal", message: "Config must contain an agent section." },
    { code: "CONFIG_MODEL_MISSING", severity: "fatal", message: "Config must contain a model section." },
  ];
  const diagnostics = configFailureDiagnostics(new PilotConfigError("CONFIG_AGENT_MISSING", "msg", existing));
  assert.deepEqual(diagnostics, existing);
  assert.notEqual(diagnostics, existing, "应返回副本，避免调用方改写错误自身的诊断数组");
});

test("configFailureDiagnostics：裸 throw 的错误按 code/message 转写为 fatal", () => {
  const diagnostics = configFailureDiagnostics(
    new PilotConfigError("CONFIG_INVALID_VALUE", "agent.maxOutputTokens must be a positive integer."),
  );
  assert.deepEqual(diagnostics, [
    {
      code: "CONFIG_INVALID_VALUE",
      severity: "fatal",
      message: "agent.maxOutputTokens must be a positive integer.",
      recoverable: false,
    },
  ]);
});

test("configFailureDiagnostics：非 PilotConfigError 也兜住，不留无诊断的异常通道", () => {
  const diagnostics = configFailureDiagnostics(new TypeError("x is not a function"));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CONFIG_UNEXPECTED_ERROR");
  assert.equal(diagnostics[0].severity, "fatal");
  assert.equal(diagnostics[0].hint, "TypeError");
  assert.match(diagnostics[0].message, /x is not a function/);

  const nonError = configFailureDiagnostics("boom");
  assert.match(nonError[0].message, /boom/);
});
