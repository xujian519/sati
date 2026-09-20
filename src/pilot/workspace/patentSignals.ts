/**
 * 工作区专利判据（#450 构件①）——回答「这个工作区该不该看到 patent 域」。
 *
 * 背景：`tools.visibleDomains` / `hiddenDomains` 是**机器级**配置（`~/.sati/sati.yaml`），
 * 而「是不是专利项目」是**工作区级**事实。默认把 28 个专利工具（13,671 tokens）与
 * 专利技能/角色清单推给每个工作区，使新会话首个请求的固定开销达到 33,641 tokens
 * （128k 窗口的 26%），挤压真实任务空间。
 *
 * 判据设计原则：**宁可判成专利**。误判为专利只多花固定的 schema 体积；误判为非专利
 * 会让用户整片失去能力面（32/32 内置角色都声明了 patent 域），且没有任何提示。
 * 因此所有判据都是「存在即命中」，且扫描被截断时按命中处理（见 `transcript-history`）。
 *
 * 纯函数 + 可注入 fs：注册表装配期调用一次，测试不需要真实磁盘。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PILOT_PROJECT_DIR_NAME } from "../../shared/paths/pilotPaths.js";

/** 判据要用的最小 fs 面（可注入；默认走 node:fs，读失败一律当成"不存在"）。 */
export type PatentSignalFs = {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readTextFile(path: string, maxBytes: number): string | undefined;
  listNames(path: string): string[];
};

export type PatentSignalName =
  | "explicit-config"
  | "patents-config"
  | "rules-pack"
  | "project-skills"
  | "patent-artifacts"
  | "transcript-history"
  | "none";

export type PatentSignalVerdict = {
  /** patent 域是否可见（= 工具注册 + 技能/角色清单）。 */
  enabled: boolean;
  /** 命中的判据；`none` 表示全部判据都没命中。 */
  signal: PatentSignalName;
  /** 命中的具体证据（路径 / 技能名 / 片段），供日志与设置页展示。 */
  evidence?: string;
};

export type PatentSignalInput = {
  projectRoot: string;
  /** `tools.patentDomain` 显式声明；`undefined` = 走自动判据（最高优先）。 */
  explicit?: boolean;
  /** 机器级 sati.yaml 是否声明了 `patents:` 段。 */
  hasPatentsConfig?: boolean;
  /**
   * 项目 transcript 目录（`<pilotHome>/projects/<projectId>/chats`）。
   * 缺省 = 跳过历史判据（既有用户保护会弱一档，调用方应尽量传入）。
   */
  projectChatsDir?: string;
  fs?: PatentSignalFs;
};

/** 专利域的工具 `domain` 标记（`ToolRegistry.listByDomains` 的 key）。 */
export const PATENT_DOMAIN = "patent";

/** 项目技能里视为"专利工作区"的目录名前缀（内置专利技能命名约定）。 */
export const PATENT_SKILL_PREFIXES = ["patent-", "provision-", "drafting-"] as const;

/** 技能名是否属于专利能力面（非专利工作区不列进 `<available-skills>` / `<available-roles>`）。 */
export function isPatentSkillName(name: string): boolean {
  const lowered = name.toLowerCase();
  return PATENT_SKILL_PREFIXES.some(prefix => lowered.startsWith(prefix));
}

/** 规则包清单文本里出现这些词即认为引用了专利规则。 */
const PATENT_RULES_PATTERN = /patent|专利/i;

/** transcript 历史判据：出现过 patent_ 前缀的工具调用名。 */
const PATENT_TOOL_CALL_PATTERN = /"patent_[a-z_]+"|patent_[a-z_]+\(/;

/** 单文件读取上限（判据只需前缀命中，超大文件不整读）。 */
const SIGNAL_FILE_MAX_BYTES = 64 * 1024;

/** transcript 历史扫描默认上限：文件数 / 总字节（单文件上限见 `SIGNAL_FILE_MAX_BYTES`）。 */
export const TRANSCRIPT_SCAN_MAX_FILES = 40;
export const TRANSCRIPT_SCAN_MAX_BYTES = 16 * 1024 * 1024;

export const defaultPatentSignalFs: PatentSignalFs = {
  exists: path => existsSync(path),
  isDirectory: path => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readTextFile: (path, maxBytes) => {
    try {
      return readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, maxBytes);
    } catch {
      return undefined;
    }
  },
  listNames: path => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/**
 * 判定工作区是否属于专利域。顺序即优先级，首个命中即返回。
 *
 * 1. `tools.patentDomain` 显式声明（用户意志最高优先，两个方向都算）
 * 2. 机器级 sati.yaml 有 `patents:` 段（显式专利意图）
 * 3. `<projectRoot>/.sati/rules.yaml` 引用专利规则包
 * 4. `<projectRoot>/.sati/skills/` 下有 patent-* / provision-* / drafting-* 技能
 * 5. 工作区存在专利产物（`data/cases` / `.sati/figures*` / `.sati/documents`）
 * 6. 该项目历史 transcript 里出现过 `patent_*` 工具调用（既有用户保护，保守判命中）
 */
export function detectPatentWorkspace(input: PatentSignalInput): PatentSignalVerdict {
  if (input.explicit !== undefined) {
    return { enabled: input.explicit, signal: "explicit-config" };
  }
  if (input.hasPatentsConfig === true) {
    return { enabled: true, signal: "patents-config" };
  }

  const fs = input.fs ?? defaultPatentSignalFs;
  const projectDir = resolve(input.projectRoot, PILOT_PROJECT_DIR_NAME);

  const rulesPack = matchRulesPack(fs, resolve(projectDir, "rules.yaml"));
  if (rulesPack) {
    return { enabled: true, signal: "rules-pack", evidence: rulesPack };
  }

  const skill = matchProjectSkills(fs, resolve(projectDir, "skills"));
  if (skill) {
    return { enabled: true, signal: "project-skills", evidence: skill };
  }

  const artifact = matchPatentArtifact(fs, input.projectRoot, projectDir);
  if (artifact) {
    return { enabled: true, signal: "patent-artifacts", evidence: artifact };
  }

  if (input.projectChatsDir && matchTranscriptHistory(fs, input.projectChatsDir)) {
    return { enabled: true, signal: "transcript-history", evidence: input.projectChatsDir };
  }

  return { enabled: false, signal: "none" };
}

/** 显式声明优先，否则用判据（装配点的唯一判据入口）。 */
export function resolvePatentDomainEnabled(input: PatentSignalInput): PatentSignalVerdict {
  return detectPatentWorkspace(input);
}

function matchRulesPack(fs: PatentSignalFs, rulesPath: string): string | undefined {
  const text = fs.readTextFile(rulesPath, SIGNAL_FILE_MAX_BYTES);
  if (text === undefined) return undefined;
  return PATENT_RULES_PATTERN.test(text) ? rulesPath : undefined;
}

function matchProjectSkills(fs: PatentSignalFs, skillsDir: string): string | undefined {
  if (!fs.isDirectory(skillsDir)) return undefined;
  for (const name of fs.listNames(skillsDir)) {
    const lowered = name.toLowerCase();
    if (PATENT_SKILL_PREFIXES.some(prefix => lowered.startsWith(prefix))) {
      return resolve(skillsDir, name);
    }
  }
  return undefined;
}

function matchPatentArtifact(fs: PatentSignalFs, projectRoot: string, projectDir: string): string | undefined {
  const casesDir = resolve(projectRoot, "data", "cases");
  if (fs.isDirectory(casesDir) && fs.listNames(casesDir).length > 0) {
    return casesDir;
  }
  if (fs.isDirectory(projectDir)) {
    for (const name of fs.listNames(projectDir)) {
      const lowered = name.toLowerCase();
      if (lowered.startsWith("figures") || lowered === "documents") {
        return resolve(projectDir, name);
      }
    }
  }
  return undefined;
}

export type TranscriptScanLimits = {
  /** 最多读多少个会话文件（按名字倒序取最近的）。 */
  maxFiles: number;
  /** 累计读取字节上限；越过即停止扫描。 */
  maxBytes: number;
};

export const DEFAULT_TRANSCRIPT_SCAN_LIMITS: TranscriptScanLimits = {
  maxFiles: TRANSCRIPT_SCAN_MAX_FILES,
  maxBytes: TRANSCRIPT_SCAN_MAX_BYTES,
};

/**
 * 历史 transcript 判据（既有用户保护）。两条保守规则：
 *
 * - **取最近的文件**：会话文件名按字典序倒序，先扫最新的（专利调用通常在近期会话里），
 *   文件数上限因此只削掉最老的历史。
 * - **字节预算截断 ⇒ 判命中**：还有没读到的内容就返回"是专利工作区"。漏判的代价是
 *   用户静默失去整片能力面，多判只多花固定的 schema 体积——代价不对称，故宁多不少。
 */
export function matchTranscriptHistory(
  fs: PatentSignalFs,
  chatsDir: string,
  limits: TranscriptScanLimits = DEFAULT_TRANSCRIPT_SCAN_LIMITS,
): boolean {
  if (!fs.isDirectory(chatsDir)) return false;
  const entries = fs
    .listNames(chatsDir)
    .filter(name => name.endsWith(".jsonl") || name.endsWith(".json"))
    .sort()
    .slice(-limits.maxFiles);
  if (entries.length === 0) return false;

  let scannedBytes = 0;
  for (const name of entries) {
    const content = fs.readTextFile(resolve(chatsDir, name), SIGNAL_FILE_MAX_BYTES);
    if (content === undefined) continue;
    if (PATENT_TOOL_CALL_PATTERN.test(content)) return true;
    scannedBytes += content.length;
    if (scannedBytes >= limits.maxBytes) {
      return true;
    }
  }
  return false;
}
