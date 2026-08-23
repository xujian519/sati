// 负控制专用 ESLint config：仅用于 tests/development-standards/lint-contract.spec.ts
// 对 lint-fixtures/ 强制校验 G2 类型感知规则与 no-restricted-imports。
// 不被根 eslint.config.mjs 引用，故不进入常规 lint；专为"证明门禁真的会红"而设。
import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  files: ["tests/development-standards/lint-fixtures/**/*.ts"],
  languageOptions: {
    parserOptions: { projectService: true },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "node:child_process", importNames: ["exec", "execSync"] },
          { name: "child_process", importNames: ["exec", "execSync"] },
        ],
      },
    ],
  },
});
