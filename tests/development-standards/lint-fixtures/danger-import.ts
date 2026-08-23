// 负控制 fixture：故意违反 no-restricted-imports（禁止从 node:child_process 导入 exec）。
// 仅供 tests/development-standards/lint-contract.spec.ts 校验"门禁真的会红"，
// 已被根 eslint.config.mjs ignore，不进入常规 lint。
import { exec } from "node:child_process";

export function run(): void {
  exec("ls", () => undefined);
}
