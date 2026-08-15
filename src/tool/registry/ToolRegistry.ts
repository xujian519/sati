import type { CanonicalToolSchema } from "../../model/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/** 注册表选项（阶段四 T9）。 */
export type ToolRegistryOptions = {
  /**
   * 新工具 canonical 输出契约强制：为 true 时，未声明 outputSchema 的工具
   * 在注册期 fail-loud。默认 false（存量注册表不受影响；存量工具分批复用
   * schema 后按注册表逐步开启）。
   */
  requireOutputSchema?: boolean;
};

export class ToolRegistry {
  private readonly toolsByName = new Map<string, SatiToolDefinition>();
  private readonly aliases = new Map<string, string>();
  /** 排序后的工具列表缓存（惰性构建，注册表变更时失效）。 */
  private sortedCache: SatiToolDefinition[] | null = null;

  constructor(private readonly options: ToolRegistryOptions = {}) {}

  register(tool: SatiToolDefinition): void {
    if (this.options.requireOutputSchema === true && tool.outputSchema === undefined) {
      throw new Error(
        `Tool ${tool.name} is missing its canonical outputSchema (phase 4 T9: new tools must declare one).`,
      );
    }
    if (this.toolsByName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }

    if (this.aliases.has(tool.name)) {
      throw new Error(`Tool ${tool.name} conflicts with an existing alias.`);
    }

    for (const alias of tool.aliases ?? []) {
      if (this.toolsByName.has(alias)) {
        throw new Error(`Alias ${alias} conflicts with an existing tool name.`);
      }
      if (this.aliases.has(alias)) {
        throw new Error(`Alias ${alias} is already registered.`);
      }
    }

    this.toolsByName.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
    this.invalidateCache();
  }

  get(name: string): SatiToolDefinition | undefined {
    const realName = this.aliases.get(name) ?? name;
    return this.toolsByName.get(realName);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * 返回按名称排序的工具列表。
   *
   * 性能说明：排序结果缓存到 `sortedCache`，注册表未变更时 `list()` 为
   * O(1)（agent 每轮模型请求会调用两次，避免每次全量排序）。返回内部缓存
   * 数组引用——调用方必须将其视为只读，不得修改返回的数组或元素。
   */
  list(): SatiToolDefinition[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    return this.sortedCache;
  }

  /**
   * 按业务域过滤工具（角色感知裁剪，引入自 BCIP filter_tools_by_role）。
   * 语义：
   *   - 工具定义了 domain 且属于 `hidden` → 排除（hidden 优先）
   *   - 工具定义了 domain 且 `visible` 非空且不属于它 → 排除
   *   - 未定义 domain 的工具始终可见（向后兼容：不归属任何域）
   * visible 为空/未提供 = 不过滤（仅 hidden 生效）。
   */
  listByDomains(options?: { visible?: Set<string>; hidden?: Set<string> }): SatiToolDefinition[] {
    const visible = options?.visible;
    const hidden = options?.hidden;
    return this.list().filter(tool => {
      const domain = tool.domain;
      if (domain === undefined) return true;
      if (hidden?.has(domain)) return false;
      if (visible !== undefined && visible.size > 0 && !visible.has(domain)) return false;
      return true;
    });
  }

  toCanonicalSchemas(options?: { visible?: Set<string>; hidden?: Set<string> }): CanonicalToolSchema[] {
    const tools = options ? this.listByDomains(options) : this.list();
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Shallow-clone this registry so the caller can register additional tools
   * (or replace existing ones) without mutating the original.  Tool
   * definitions are shared by reference — only the lookup maps are copied.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [name, tool] of this.toolsByName) {
      copy.toolsByName.set(name, tool);
    }
    for (const [alias, realName] of this.aliases) {
      copy.aliases.set(alias, realName);
    }
    return copy;
  }

  /**
   * Remove a tool (and its aliases) from the registry.
   * Returns true if the tool was found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    const tool = this.toolsByName.get(name);
    if (!tool) return false;
    for (const alias of tool.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.toolsByName.delete(name);
    this.invalidateCache();
    return true;
  }

  /**
   * Replace an existing tool definition in-place.  Unlike `register()`,
   * this overwrites the entry keyed by `tool.name` (which must already
   * exist).  Aliases from the *previous* definition are removed and
   * replaced with those from the new one.
   */
  replace(tool: SatiToolDefinition): void {
    const existing = this.toolsByName.get(tool.name);
    if (!existing) {
      throw new Error(`Tool ${tool.name} is not registered — cannot replace.`);
    }
    for (const alias of existing.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.toolsByName.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.sortedCache = null;
  }
}
