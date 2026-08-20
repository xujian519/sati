import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths, discoverSkillPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath, loadSkillFromPath } from "../loading/PluginLoader.js";
import { loadPluginHooks } from "../loading/PluginHookLoader.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { SatiLoadedPlugin } from "../protocol/plugin.js";
import type { SatiHooksSettings } from "../../hooks/protocol/settings.js";
import type { SatiCustomRouter } from "../../../router/customRouter/customRouter.js";
import { isRoleFrontmatter, parseRoleConfig } from "../../skills/roleConfig.js";
import { renderSkillContent } from "../../skills/renderSkillContent.js";
import type { SkillRoleConfig } from "../../skills/types.js";
import { PluginRegistry } from "./PluginRegistry.js";
import { truncateMcpInstructionString } from "./truncateMcpString.js";

/** M6：插件/技能 load 指纹缓存 TTL（stat 粒度漏检兜底，10s 后强制重扫）。 */
const PLUGIN_FINGERPRINT_TTL_MS = 10_000;

/**
 * Static MCP server contribution shape callers can rely on. Manifests load
 * `mcpServers` as `Record<string, unknown>` to stay forward-compatible, so
 * this type is *advisory* — the runtime only reads `instructions` and falls
 * back gracefully when missing.
 */
export type SatiMcpServerStaticSpec = {
  instructions?: string;
  [key: string]: unknown;
};

/**
 * Aggregated B3 instruction entry (always non-empty `instructions`). Exposed
 * as a stricter alias of {@link PluginMcpInstruction} so callers that only
 * care about *populated* entries keep a non-optional `instructions` field.
 */
export type SatiMcpInstructionEntry = {
  serverName: string;
  instructions: string;
};

export type PluginRuntimeOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Read-only skills shipped with the active Sati build. */
  builtinSkillsRoot?: string;
  builtinPlugins?: SatiLoadedPlugin[];
  builtinPluginsEnabled?: Record<string, boolean>;
};

export type PluginRefreshResult = {
  previous: SatiLoadedPlugin[];
  next: SatiLoadedPlugin[];
  added: SatiLoadedPlugin[];
  removed: SatiLoadedPlugin[];
};

export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md. */
  path: string;
  namespace?: string;
  /** `type: "role"` skill 的角色配置。 */
  role?: SkillRoleConfig;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

export type PluginContributionSnapshot = {
  plugins: SatiLoadedPlugin[];
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  outputStyles: LoadedPluginCommand[];
  hooks: SatiHooksSettings;
  mcpServers: Record<string, unknown>;
  lspServers: Record<string, unknown>;
  mcpInstructions: PluginMcpInstruction[];
};

export class PluginRuntime {
  private readonly registry = new PluginRegistry();
  /**
   * In-flight refresh promise：并发 refresh() 调用共享同一次全量扫描与加载
   * （如多个会话同时创建），避免重复的目录扫描/文件读取。refresh() 语义
   * 保持不变——每次都重新加载，不做时间窗口缓存（文件系统变更必须立即可见）。
   */
  private inFlightRefresh: Promise<SatiLoadedPlugin[]> | null = null;
  /**
   * M6：插件/技能 load 结果指纹缓存。指纹 = 各发现文件 mtime+size 拼接；
   * TTL 兜底（stat 粒度漏检的极端情况 10s 后强制重扫）。命中时跳过逐文件
   * 读盘解析（会话并发创建每会话一次 refresh → 只扫一次盘）。文件内容
   * 变更 → mtime 变化 → 指纹变 → 立即重扫，变更可见性语义不变。
   */
  private fingerprintCache: { fingerprint: string; plugins: SatiLoadedPlugin[]; at: number } | null = null;

  constructor(private readonly options: PluginRuntimeOptions) {}

  /**
   * M6：发现路径列表 → mtime+size 指纹。discover 返回的是目录路径（插件目录 /
   * SKILL.md 所在目录），目录 mtime 只随子项增删变化——内容编辑须靠文件自身
   * mtime+size 捕捉。加载实际读取面 = plugin.json + hooks + commands/skills/
   * output-styles 内任意嵌套 .md（collectMarkdownFiles 递归），故指纹须递归
   * 覆盖整棵目录树（#8a：嵌套文件内容编辑不得被 TTL 延迟）；条目按名称排序，
   * 保证 readdir 序无关的确定性指纹（#8b）。
   */
  private async fingerprintOf(files: Array<{ path: string }>): Promise<string> {
    let fingerprint = "";
    for (const file of files) {
      const st = await stat(file.path).catch(() => null);
      fingerprint += `${file.path}:${st?.mtimeMs ?? 0}:${st?.size ?? 0}`;
      if (st?.isDirectory()) {
        fingerprint += await this.treeFingerprint(file.path);
      }
      fingerprint += ";";
    }
    return fingerprint;
  }

  /** 目录树全文件指纹（递归 + 排序；不跟随目录符号链接——外部大目录会放大递归成本）。 */
  private async treeFingerprint(dir: string): Promise<string> {
    const entries = (await readdir(dir).catch(() => [] as string[])).sort();
    let out = "";
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const linkSt = await lstat(fullPath).catch(() => null);
      if (!linkSt) continue;
      if (linkSt.isDirectory() && !linkSt.isSymbolicLink()) {
        out += `|${entry}:d`;
        out += await this.treeFingerprint(fullPath);
      } else {
        // 文件/符号链接统一 stat（跟随链接取目标 mtime+size，链接目标变更亦能捕捉）
        const st = await stat(fullPath).catch(() => null);
        out += `|${entry}:${st?.mtimeMs ?? 0}:${st?.size ?? 0}`;
      }
    }
    return out;
  }

  snapshot(): SatiLoadedPlugin[] {
    return this.registry.list();
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map(plugin => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  /**
   * Read-only static instructions aggregator (deferred-feature §5.3 / B3).
   * - Iterates `mcpServers` from every loaded plugin.
   * - Filters entries with a non-empty `instructions: string` field.
   * - Truncates each entry to {@link truncateMcpInstructionString} (2048 chars).
   * - Returns a stable list sorted by `serverName` (avoids prompt-cache thrash).
   *
   * Once C1 (real MCP runtime) lands, the runtime can layer dynamic
   * instructions on top via the same `getAllMcpInstructions` aggregator
   * surface used by `PluginRuntimeExtensionResolver`.
   */
  getAllMcpInstructions(): SatiMcpInstructionEntry[] {
    const entries: SatiMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.registry.list()) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = (raw as SatiMcpServerStaticSpec).instructions;
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(trimmed),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
  }

  lspServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map(plugin => plugin.lspServers ?? {})) as Record<string, unknown>;
  }

  snapshotContributions(): PluginContributionSnapshot {
    const plugins = this.registry.list();
    return {
      plugins,
      commands: plugins.flatMap(plugin =>
        (plugin.commands ?? []).map(command => toCommandContribution(plugin, command)),
      ),
      skills: collectSkillContributions(plugins),
      outputStyles: plugins.flatMap(plugin => plugin.outputStyles ?? []),
      hooks: loadPluginHooks(plugins),
      mcpServers: this.mcpServers(),
      lspServers: this.lspServers(),
      mcpInstructions: this.getAllMcpInstructions(),
    };
  }

  getAllCommands(): PluginCommandContribution[] {
    return this.snapshotContributions().commands;
  }

  getAllSkills(): PluginSkillContribution[] {
    return this.snapshotContributions().skills;
  }

  lookupRouter(extensionId: string): SatiCustomRouter | undefined {
    for (const plugin of this.registry.list()) {
      for (const contribution of plugin.routerContributions ?? []) {
        if (contribution.id !== extensionId) {
          continue;
        }
        return contribution.createCustomRouter();
      }
    }
    return undefined;
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority(this.registry.list());

    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find(contribution => contribution.name === extensionId);
      if (prompt) {
        return prompt.content;
      }
    }

    for (const plugin of plugins) {
      const skill = plugin.skills?.find(entry => entry.name === extensionId);
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    // Resolve namespaced plugin skills by their short name only after exact
    // standalone names have had a chance to resolve.
    for (const plugin of plugins) {
      const skill = plugin.skills?.find(entry => entry.name.endsWith(`:${extensionId}`));
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    for (const plugin of plugins) {
      const command = plugin.commands?.find(
        entry => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`),
      );
      if (command) {
        return command.content;
      }
    }
    return undefined;
  }

  async refresh(): Promise<SatiLoadedPlugin[]> {
    // 并发调用共享同一次刷新（会话并发创建时只扫描一次磁盘）；
    // 串行调用每次都真实重新加载，保证文件系统变更立即可见。
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }
    this.inFlightRefresh = (async () => (await this.refreshWithReport()).next)();
    try {
      return await this.inFlightRefresh;
    } finally {
      this.inFlightRefresh = null;
    }
  }

  async refreshWithReport(): Promise<PluginRefreshResult> {
    const previous = this.registry.list();
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
    });
    const [discovered, discoveredSkills] = await Promise.all([
      discoverPluginPaths([
        { path: paths.globalPluginsDir, source: "global" },
        { path: paths.projectPluginsDir, source: "project" },
      ]),
      discoverSkillPaths([
        ...(this.options.builtinSkillsRoot
          ? [{ path: this.options.builtinSkillsRoot, source: "builtin" as const }]
          : []),
        { path: paths.globalSkillsDir, source: "global" },
        { path: paths.projectSkillsDir, source: "project" },
      ]),
    ]);
    // M6：指纹命中（文件未变且 TTL 内）→ 直接复用上次 load 结果，跳过读盘解析。
    const fingerprint = await this.fingerprintOf([...discovered, ...discoveredSkills]);
    const cached = this.fingerprintCache;
    if (cached !== null && cached.fingerprint === fingerprint && Date.now() - cached.at < PLUGIN_FINGERPRINT_TTL_MS) {
      this.registry.replaceAll(cached.plugins);
      return {
        previous,
        next: cached.plugins,
        // #8d：命中时也按实际 registry 状态计算 diff——previous 可能被外部
        // 改动（registry 非只由本方法维护），空数组会让消费者漏掉增量处理。
        added: cached.plugins.filter(plugin => !hasPlugin(previous, plugin)),
        removed: previous.filter(plugin => !hasPlugin(cached.plugins, plugin)),
      };
    }
    const [loaded, loadedSkills] = await Promise.all([
      Promise.all(discovered.map(plugin => loadPluginFromPath(plugin.path, plugin.source).catch(() => undefined))),
      Promise.all(discoveredSkills.map(s => loadSkillFromPath(s.path, s.source).catch(() => undefined))),
    ]);
    const plugins = [
      ...enabledBuiltinPlugins(this.options.builtinPlugins ?? [], this.options.builtinPluginsEnabled ?? {}),
      ...loaded.filter(isLoadedPlugin),
      ...loadedSkills.filter(isLoadedPlugin),
    ];
    // #8c：部分加载失败不写指纹缓存——失败多为瞬时（IO 抖动/锁），缓存会把
    // 失败结果固化到 TTL（命中时跳过失败项且不重试）；失败态重扫成本低
    // （目录小），全成功才享受缓存是正确取舍。
    const loadFailed = loaded.some(item => item === undefined) || loadedSkills.some(item => item === undefined);
    this.fingerprintCache = loadFailed ? null : { fingerprint, plugins, at: Date.now() };
    this.registry.replaceAll(plugins);
    return {
      previous,
      next: plugins,
      added: plugins.filter(plugin => !hasPlugin(previous, plugin)),
      removed: previous.filter(plugin => !hasPlugin(plugins, plugin)),
    };
  }
}

function isLoadedPlugin(value: SatiLoadedPlugin | undefined): value is SatiLoadedPlugin {
  return value !== undefined;
}

function enabledBuiltinPlugins(plugins: SatiLoadedPlugin[], enabled: Record<string, boolean>): SatiLoadedPlugin[] {
  return plugins.filter(plugin => plugin.source !== "builtin" || enabled[plugin.name] !== false);
}

function hasPlugin(plugins: SatiLoadedPlugin[], plugin: SatiLoadedPlugin): boolean {
  return plugins.some(candidate => candidate.name === plugin.name && candidate.source === plugin.source);
}

function toCommandContribution(plugin: SatiLoadedPlugin, command: LoadedPluginCommand): PluginCommandContribution {
  return {
    name: command.name,
    description: typeof command.frontmatter.description === "string" ? command.frontmatter.description : undefined,
    argumentHint:
      typeof command.frontmatter["argument-hint"] === "string" ? command.frontmatter["argument-hint"] : undefined,
    namespace: plugin.name,
  };
}

function toSkillContribution(plugin: SatiLoadedPlugin, skill: LoadedPluginCommand): PluginSkillContribution {
  const fm = skill.frontmatter ?? {};
  return {
    name: skill.name,
    description: typeof fm.description === "string" ? fm.description : undefined,
    path: skill.path,
    namespace: plugin.name,
    role: isRoleFrontmatter(fm) ? parseRoleConfig(fm) : undefined,
  };
}

function sourcePriority(source: SatiLoadedPlugin["source"]): number {
  switch (source) {
    case "project":
      return 2;
    case "global":
      return 1;
    case "builtin":
    default:
      return 0;
  }
}

function sortByResolutionPriority(plugins: SatiLoadedPlugin[]): SatiLoadedPlugin[] {
  return [...plugins].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
}

function collectSkillContributions(plugins: SatiLoadedPlugin[]): PluginSkillContribution[] {
  const selected = new Map<string, { contribution: PluginSkillContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const skill of plugin.skills ?? []) {
      const contribution = toSkillContribution(plugin, skill);
      const existing = selected.get(contribution.name);
      if (!existing || priority >= existing.priority) {
        selected.set(contribution.name, { contribution, priority });
      }
    }
  }
  return [...selected.values()].map(entry => entry.contribution);
}
