import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import importX from "eslint-plugin-import-x";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

/**
 * Root ESLint config — covers backend core (src/), tests/ and scripts/.
 * Keep rule preferences consistent with ui/eslint.config.js.
 *
 * Code formatting is delegated to Biome (biome.json); this config only
 * enforces lint rules that Biome does not cover.
 */
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "ui/**",
      "skills/**",
      "products/**",
      "vendor/**",
      // P2-07 单一事实源资产：浏览器侧脚本（document 等 DOM API），
      // 不经根 lint（node globals）校验，版本标记/转义约束由加载端把关。
      "assets/patent/**",
      "apps/desktop/dist/**",
      "apps/desktop/dist-electron/**",
      // edgeclaw-memory-core 子包：src/ 纳入 lint（2026-08-17 开闸清 116 处），
      // 但 ui-source/（浏览器端代码，根 globals 仅 node）与 lib/（构建产物）
      // 不适用根 lint 规则，局部排除。
      "src/context/memory/edgeclaw-memory-core/ui-source/**",
      "src/context/memory/edgeclaw-memory-core/lib/**",
      // 负控制 fixture(故意违规,仅供 tests/development-standards/lint-contract.spec.ts 校验),
      // 不进入常规 lint,避免污染 pnpm lint。
      "tests/development-standards/lint-fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 类型感知 lint(G2, docs/development-standards.md §7 第 2 步)：
    // no-floating-promises / no-misused-promises 需要 projectService(type-aware)。
    // 这是外部规范《AI 原生开发规范》里"agent loop 里丢失的 promise"最高价值缺陷类的落地。
    // 分步收敛：先只对 src/(核心后端)开；tests/scripts 暂未 type-aware,属分批第一步。
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    // edgeclaw-memory-core 是独立 workspace 子包(有独立 tsconfig);
    // root tsconfig exclude 它,projectService 无法解析其 tests/** → 需在此层排除,
    // 否则报 Parsing error(其 src/ 仍由下方主 block 以根规则 lint)。
    ignores: ["src/context/memory/edgeclaw-memory-core/**"],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // 危险 API 禁令(disallowed-methods)：独立于 type-aware block,避免被其运行时/析构牵连。
    // 仅对核心后端 src/ 生效;child_process.exec/execSync 经 shell 解释命令存在注入面,
    // Sati 已用 execFile/execFileSync(数组参数)替代。
    // 豁免:apps/desktop(桌面壳 + release 脚本,刻意的同步 shell 构建/平台命令)与
    // tests/scripts(构建/工具层)。核心运行时(src/)是注入风险的主轮廓。
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["exec", "execSync"],
              message:
                "禁止 child_process.exec/execSync：命令经 shell 解释存在注入面。用 execFile/execFileSync(数组参数)替代；确需 shell 时用 spawn 且勿拼接用户输入。",
            },
            {
              name: "child_process",
              importNames: ["exec", "execSync"],
              message:
                "禁止 child_process.exec/execSync：命令经 shell 解释存在注入面。用 execFile/execFileSync(数组参数)替代；确需 shell 时用 spawn 且勿拼接用户输入。",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "tests/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "apps/desktop/scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "apps/desktop/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      // GitHub Actions 本地校验脚本（CI gate 等）与根 scripts/ 同类：Node 环境，
      // 需注入 globals.node，避免 process/console 报 no-undef。
      ".github/scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    ],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "import-x": importX,
      "unused-imports": unusedImports,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // --- Unused imports/vars ---
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",

      // --- React (Ink TUI components) ---
      "react/jsx-key": "warn",
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-no-undef": "error",
      "react/no-danger-with-children": "error",
      "react/no-direct-mutation-state": "error",
      "react/react-in-jsx-scope": "off",

      // --- React Hooks ---
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // --- Import ordering & hygiene (consistent with ui/) ---
      // Note: import-x/no-duplicates is intentionally NOT enabled — its autofix
      // merges duplicate import statements and can corrupt `import type` vs value
      // imports (value names silently become type-only imports, breaking runtime).
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "never",
        },
      ],

      // --- Disabled base rules (consistent with ui/) ---
      // no-explicit-any: warn 而非 off —— 存量 any（约 170 处）开始可见，新代码不再无感引入。
      // 收敛进度：逐处改为 unknown 或具体类型；warn 不阻断 CI。
      // 治理机制：不设 eslint max-warnings（存量 warning 会让 CI 立即变红、阻断全部合入，
      // 反而无人清理）；改为「PR 评审把关新引入的 any」+ 按模块分批收敛
      // （优先 context/agent/router），存量清单见各文件 lint 输出。
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      // 禁 @ts-ignore / @ts-nocheck，允许带说明的 @ts-expect-error —— 与 AGENTS.md 铁律一致
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      // 下列三条来自 js/tseslint recommended，Sati 代码库存在合法用途，故显式关闭（不用静默）。
      "no-case-declarations": "off", // switch case 内借用块级大括号的局部声明是既有风格
      "no-control-regex": "off", // 控制字符匹配（如 \u0000-\u001f 类）在协议/清洗代码中合法使用
      "no-useless-escape": "off", // 部分看似多余的转义用于跨方言/工具兼容，属有意保留
    },
  },
];
