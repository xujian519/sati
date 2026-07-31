import type { CanonicalToolSchema } from "../../model/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export class ToolRegistry {
  private readonly toolsByName = new Map<string, SatiToolDefinition>();
  private readonly aliases = new Map<string, string>();

  register(tool: SatiToolDefinition): void {
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
  }

  get(name: string): SatiToolDefinition | undefined {
    const realName = this.aliases.get(name) ?? name;
    return this.toolsByName.get(realName);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): SatiToolDefinition[] {
    return [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  }
}
