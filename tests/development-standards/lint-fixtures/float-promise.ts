// 负控制 fixture：故意违反 @typescript-eslint/no-floating-promises。
// 仅供 tests/development-standards/lint-contract.spec.ts 校验"门禁真的会红"，
// 已被根 eslint.config.mjs ignore，不进入常规 lint。
export function fire(): void {
  doSomething();
}

function doSomething(): Promise<void> {
  return Promise.resolve();
}
