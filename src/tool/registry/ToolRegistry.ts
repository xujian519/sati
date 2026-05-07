import type { CanonicalToolSchema } from "../../model/index.js";
import type { PolitDeckToolDefinition } from "../protocol/types.js";

export class ToolRegistry {
  private readonly toolsByName = new Map<string, PolitDeckToolDefinition>();
  private readonly aliases = new Map<string, string>();

  register(tool: PolitDeckToolDefinition): void {
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

  get(name: string): PolitDeckToolDefinition | undefined {
    const realName = this.aliases.get(name) ?? name;
    return this.toolsByName.get(realName);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): PolitDeckToolDefinition[] {
    return [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  toCanonicalSchemas(): CanonicalToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}
