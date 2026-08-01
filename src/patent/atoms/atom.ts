/**
 * Atom 抽象层（移植自 Mady agentcore/atom.go 设计）。
 *
 * Atom 是 Pipeline 原子操作的**声明式契约**：只描述元数据（名称/描述/分类/
 * 输入输出键），不包含任何执行逻辑。执行由对应的 StageHandler 承担（handler.ts），
 * 二者经注册表解耦 —— 同一 Atom 可对应多个 Handler 实现（测试/替换友好）。
 *
 * 设计原则：
 * - 输入输出键列表用于校验、文档化与插件引用（与 Mady InputSchema/OutputSchema 对齐）
 * - 同名注册覆盖先前定义（可测试、可扩展）
 * - 全局注册表 + 可注入局部注册表（workflow 执行时可选注入，隔离测试）
 */

export type AtomCategory = "search" | "extract" | "compare" | "reason" | "gate";

export type Atom = {
  /** 全局唯一标识（与 StageHandler.name 一致） */
  name: string;
  /** 人类可读说明 */
  description: string;
  /** 分类（search/extract/compare/reason/gate） */
  category: AtomCategory;
  /** 期望从 PipelineState 读取的输入键列表 */
  inputSchema: string[];
  /** 声明写入 PipelineState 的输出键列表（第一个为主输出键） */
  outputSchema: string[];
};

export class AtomRegistry {
  private readonly atoms = new Map<string, Atom>();

  /** 同名注册覆盖先前定义（对齐 Mady 覆盖语义，便于测试与扩展）。 */
  register(atom: Atom): void {
    if (!atom.name.trim()) throw new AtomRegistryError("Atom 缺少 name");
    if (!atom.description.trim()) throw new AtomRegistryError(`Atom "${atom.name}" 缺少 description`);
    this.atoms.set(atom.name, atom);
  }

  lookup(name: string): Atom | undefined {
    return this.atoms.get(name);
  }

  list(): Atom[] {
    return [...this.atoms.values()];
  }

  listByCategory(category: AtomCategory): Atom[] {
    return this.list().filter(a => a.category === category);
  }
}

export class AtomRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomRegistryError";
  }
}

/** 全局注册表（内置原子经 registerBuiltinAtoms 注册于此）。 */
export const globalAtomRegistry = new AtomRegistry();

export function RegisterAtom(atom: Atom): void {
  globalAtomRegistry.register(atom);
}

export function LookupAtom(name: string): Atom | undefined {
  return globalAtomRegistry.lookup(name);
}

export function ListAtoms(): Atom[] {
  return globalAtomRegistry.list();
}

export function ListAtomsByCategory(category: AtomCategory): Atom[] {
  return globalAtomRegistry.listByCategory(category);
}
