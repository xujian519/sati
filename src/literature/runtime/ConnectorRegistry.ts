/**
 * 学术文献 Connector 注册表。
 *
 * 单个共享实例由装配函数 `createLiteratureRegistry` 提供；工具层
 * （`paper_search` / `paper_list_sources`）只通过 `get`/`catalog` 路由，
 * 不感知具体数据库（设计引入自 OpenScience ConnectorRegistry）。
 */
import type { CatalogEntry, Connector } from "../protocol/types.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector "${connector.id}" is already registered`);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  all(): Connector[] {
    return [...this.connectors.values()];
  }

  /** 可序列化目录（无函数），供工具 / UI 展示。 */
  catalog(): CatalogEntry[] {
    return this.all().map(({ id, name, domain, description, homepage }) => ({
      id,
      name,
      domain,
      description,
      homepage,
    }));
  }
}
