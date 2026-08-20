/**
 * M3 T15：skills/patent-teams/ 嵌套目录角色装配。
 *
 * 背景：skills 一级扫描（discoverSkillPaths / SkillManager.scan）只检查一层
 * 子目录是否含 SKILL.md，`skills/patent-teams/` 自身无 SKILL.md，整目录被跳过。
 * T15 补装配路径：`registerNestedTeamRoleDefinitions` 对嵌套目录逐份 SKILL.md
 * 走同一 roleFromContribution → registerRoleDefinition 路径。
 *
 * 三个测试：
 * 1. 单元：mkdtemp 模拟 `skills/patent-teams/<岗>/SKILL.md` 结构（12 岗 + 1 份
 *    非角色文件），断言 12 岗 id 全注册、systemPrompt 多行块完整、domains 含
 *    "team"、readOnly 正确、非角色文件跳过。
 * 2. 单元：目录不存在/为空时返回 0 不报错；注册后可 unregister 清理回退。
 * 3. 集成（M3 完成判据）：真实 createLocalGateway（fake model）+ sati.yaml，
 *    消费一个 turn 触发首会话准备（syncRoleDefinitions）→ 断言
 *    listRegisteredRoleIds() 含 12 岗 id（真实运行时装配，非文件存在性）；
 *    getSubagentDefinition("case-manager") 可调度解析。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerNestedTeamRoleDefinitions } from "../../src/cli/teamRoleAssembly.js";
import {
  getSubagentDefinition,
  listRegisteredRoleIds,
  unregisterRoleDefinition,
} from "../../src/agent/sub/builtinSubagentTypes.js";
import { createLocalGateway, type CreateLocalGatewayResult } from "../../src/cli/createLocalGateway.js";
import type { ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

/** M3 完成判据的 12 岗 id（dsh 团队岗位，skills/patent-teams/ 子目录）。 */
const TEAM_ROLE_IDS = [
  "case-manager",
  "researcher",
  "drafter",
  "technical-expert",
  "adversarial-reviewer",
  "applicant-counsel",
  "formal-examiner",
  "invalidity-petitioner",
  "patentee-defender",
  "adjudicator",
  "defendant-counsel",
  "tech-investigator",
];

/** 最小角色 frontmatter（含多行 systemPrompt 块与数组字段，验证 yaml 解析完整性）。 */
function roleFrontmatter(slug: string, extra = ""): string {
  return [
    "---",
    `name: ${slug}`,
    `description: 模拟团队角色 ${slug}`,
    "type: role",
    'tools: ["*"]',
    'domains: ["patent", "team"]',
    'omitTools: ["execute_code"]',
    "readOnly: true",
    "systemPrompt: |-",
    `  你是模拟团队角色 ${slug}，立场指令块需完整保留。`,
    "  第二行立场指令。",
    extra,
    "---",
    "",
    `# ${slug}`,
  ].join("\n");
}

/** 在临时目录模拟 skills/patent-teams/ 结构，返回根目录。 */
function makeFakeTeamRolesRoot(): { root: string; count: number } {
  const root = mkdtempSync(join(tmpdir(), "sati-team-roles-"));
  const teamRolesDir = join(root, "patent-teams");
  mkdirSync(teamRolesDir, { recursive: true });
  for (const slug of TEAM_ROLE_IDS) {
    mkdirSync(join(teamRolesDir, slug));
    writeFileSync(join(teamRolesDir, slug, "SKILL.md"), roleFrontmatter(slug), "utf8");
  }
  // 非角色文件（无 type: role）应被跳过
  mkdirSync(join(teamRolesDir, "plain-skill"));
  writeFileSync(
    join(teamRolesDir, "plain-skill", "SKILL.md"),
    ["---", "name: plain-skill", "description: 普通技能", "---", "", "# 正文"].join("\n"),
    "utf8",
  );
  // 无 SKILL.md 的目录也应被跳过
  mkdirSync(join(teamRolesDir, "no-skill-file"));
  return { root, count: TEAM_ROLE_IDS.length };
}

test("registerNestedTeamRoleDefinitions 注册嵌套目录全部团队角色（模拟 skills/patent-teams/ 结构）", () => {
  const { root, count } = makeFakeTeamRolesRoot();
  try {
    const registered = registerNestedTeamRoleDefinitions(root);
    assert.equal(registered, count, "12 个角色文件应全部注册，非角色文件与无 SKILL.md 目录跳过");
    const ids = listRegisteredRoleIds();
    for (const id of TEAM_ROLE_IDS) {
      assert.ok(ids.includes(id), `12 岗 id 应已注册: ${id}`);
      const definition = getSubagentDefinition(id);
      assert.ok(definition, `getSubagentDefinition 应可解析 ${id}`);
      // yaml 解析完整性：systemPrompt 多行块完整、domains 数组保留、readOnly 生效
      assert.ok(
        definition?.systemPromptSuffix?.includes("立场指令块需完整保留"),
        `${id} 的多行 systemPrompt 应完整（不截断）`,
      );
      assert.ok(definition?.systemPromptSuffix?.includes("第二行立场指令"), `${id} 的 systemPrompt 第二行应保留`);
      assert.ok(definition?.visibleDomains?.includes("team"), `${id} 的 domains 应含 "team" 成员作业面`);
      assert.equal(definition?.isReadOnly, true, `${id} 的 readOnly 应生效`);
    }
  } finally {
    for (const id of TEAM_ROLE_IDS) unregisterRoleDefinition(id);
  }
  for (const id of TEAM_ROLE_IDS) {
    assert.equal(getSubagentDefinition(id), undefined, `${id} 清理后应回退未注册`);
  }
});

test("registerNestedTeamRoleDefinitions 对缺失/空目录静默返回 0", () => {
  assert.equal(registerNestedTeamRoleDefinitions(undefined), 0);
  assert.equal(registerNestedTeamRoleDefinitions(""), 0);
  const root = mkdtempSync(join(tmpdir(), "sati-no-roles-"));
  assert.equal(registerNestedTeamRoleDefinitions(root), 0, "无 patent-teams 子目录时应返回 0 不报错");
  const nested = mkdtempSync(join(tmpdir(), "sati-empty-roles-"));
  mkdirSync(join(nested, "patent-teams"));
  assert.equal(registerNestedTeamRoleDefinitions(nested), 0, "patent-teams 为空目录时应返回 0");
});

const SATI_YAML = [
  "schemaVersion: 1",
  "agent:",
  "  model: deepseek/deepseek-v4-flash",
  "model:",
  "  providers:",
  "    deepseek:",
  "      apiKey: test-key",
  "      models:",
  "        deepseek-v4-flash: {}",
  "",
].join("\n");

/** 纯文本模型：不发工具调用（T12 集成用例同款）。 */
function textOnlyModel(): ModelRuntime {
  return {
    stream: async function* () {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "本回合结束。" };
      yield { type: "message_end", finishReason: "stop" };
    },
    complete: async () => {
      throw new Error("unused");
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

test("集成：真实 createLocalGateway 首会话装配后 12 岗全部可调度（M3 完成判据）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-roles-gw-"));
  await writeFile(join(root, "sati.yaml"), SATI_YAML, "utf8");
  let result: CreateLocalGatewayResult | undefined;
  try {
    result = createLocalGateway({
      projectRoot: root,
      pilotHome: root,
      env: {},
      __testModelFactory: () => textOnlyModel(),
    });
    // 消费一个 turn 触发首会话准备（prepareSessionRuntime → syncRoleDefinitions
    // → 插件角色 + skills/patent-teams/ 嵌套角色注册）。
    const iter = result.gateway.submitTurn({ sessionKey: "probe-1", channelKey: "cli", message: "开始" });
    for await (const event of iter) {
      if (event.type === "turn_completed" || event.type === "error") break;
    }
    const ids = listRegisteredRoleIds();
    for (const id of TEAM_ROLE_IDS) {
      assert.ok(ids.includes(id), `真实运行时装配后 12 岗应全部注册: ${id}（当前 ${ids.length} 个角色）`);
    }
    // role 调度联动：subagent_type 解析可用（不抛 Unknown subagent_type）
    const caseManager = getSubagentDefinition("case-manager");
    assert.ok(caseManager, "getSubagentDefinition(case-manager) 应可解析");
    assert.ok(caseManager.visibleDomains?.includes("team"), "case-manager domains 应含 team");
    assert.ok(
      caseManager.systemPromptSuffix?.includes("案件管理员"),
      "case-manager systemPrompt 应完整（yaml 多行块）",
    );
    const adjudicator = getSubagentDefinition("adjudicator");
    assert.ok(adjudicator?.systemPromptSuffix?.includes("中立裁判"), "adjudicator 立场指令应完整");
    assert.equal(adjudicator?.isReadOnly, true, "adjudicator readOnly 应生效");
  } finally {
    for (const id of TEAM_ROLE_IDS) unregisterRoleDefinition(id);
    result?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
