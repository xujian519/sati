import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import importX from "eslint-plugin-import-x";
import tailwindcss from "eslint-plugin-tailwindcss";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "public/**"],
  },
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      react,
      "react-hooks": reactHooks, // for following React rules such as dependencies in hooks, keys in lists, etc.
      "react-refresh": reactRefresh, // for Vite HMR compatibility
      "import-x": importX, // for import order/sorting. It also detercts circular dependencies and duplicate imports.
      tailwindcss, // for detecting invalid Tailwind classnames and enforcing classname order
      "unused-imports": unusedImports, // for detecting unused imports
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
      tailwindcss: { cssConfigPath: "src/index.css" },
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

      // --- React ---
      "react/jsx-key": "warn",
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-no-undef": "error",
      "react/no-children-prop": "warn",
      "react/no-danger-with-children": "error",
      "react/no-direct-mutation-state": "error",
      "react/no-unknown-property": "warn",
      "react/react-in-jsx-scope": "off",

      // --- React Hooks ---
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // --- React Refresh (Vite HMR) ---
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // --- Import ordering & hygiene ---
      "import-x/no-duplicates": "warn",
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "never",
        },
      ],

      // --- Tailwind CSS ---
      // Disabled: automatic class ordering produces large, meaningless diffs
      // across the whole codebase whenever the plugin's sort heuristic changes.
      "tailwindcss/classnames-order": "off",
      "tailwindcss/no-contradicting-classname": "warn",
      // Disabled: the v4 plugin's fixes are not value-preserving — it rewrites
      // text-[11px] -> text-xxs (adds a line-height) and text-[14px] ->
      // text-xxs--line-height (an invalid class name), changing rendered output.
      "tailwindcss/no-unnecessary-arbitrary-value": "off",

      // --- Disabled base rules ---
      // no-explicit-any: warn 而非 off —— 与根 eslint.config.mjs 保持一致，存量 any 可见、增量收敛。
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      // 禁 @ts-ignore / @ts-nocheck，允许带说明的 @ts-expect-error —— 与根 eslint.config.mjs 及 AGENTS.md 铁律一致
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      // 下列三条来自 js/tseslint recommended，Sati 代码库存在合法用途，故显式关闭（与根 eslint.config.mjs 一致）。
      "no-case-declarations": "off", // switch case 内借用块级大括号的局部声明是既有风格
      "no-control-regex": "off", // 控制字符匹配（如 \u0000-\u001f 类）在协议/清洗代码中合法使用
      "no-useless-escape": "off", // 部分看似多余的转义用于跨方言/工具兼容，属有意保留
    },
  },
  {
    // ui/server 边界：禁止直接导入 src/ 内部实现（CLAUDE.md「ui/ 不得直接导入 src/」）。
    // 白名单 = 现存迁移中的合法入口；每个条目收敛后（走 gateway 协议或 barrel）即从 except 摘除。
    // 新增的 ui/server → src/ 导入会被拦截（error）。
    //
    // unused-imports（warn，与 src 一致）：ui/server 曾是 lint 盲区（ui lint 只跑 src/），
    // 2026-08 清理 102 处遗留未使用 import/死代码后开闸，防止再累积。
    // 详见 docs/ui-server-unused-import-cleanup-plan.md。
    //
    // no-restricted-paths 说明（2026-08-17）：该规则对 ui/server 的 NodeNext 风格
    // .js specifier 实际不生效（unrs-resolver 不做 .js→.ts 回退，解析失败即静默跳过，
    // 增减 except 均不触发——实测）。真实门禁是 scripts/check-ui-server-boundary.mjs
    // （挂 ui lint，纯路径静态校验）。except 列表保留为"意图文档 + 未来 resolver
    // 修复后的兜底"，内容与 check-ui-server-boundary 白名单同步。
    files: ["server/**/*.{js,mjs}"],
    plugins: { "import-x": importX, "unused-imports": unusedImports },
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./server",
              from: "../src",
              except: [
                // barrel 入口（2026-08-17 收口后清单，与 check-ui-server-boundary 白名单同步）
                "web/server/index.js",
                "cron/index.js",
                // 有意保留：cli 根单文件、轻依赖；顶层 cli barrel 会连带 createLocalGateway 全树
                "cli/proxy.js",
                "cli/commands/index.js",
                "context/budget/index.js",
                "gateway/index.js",
                "status/index.js",
                "web/client/index.js",
                "model/index.js",
                "network/index.js",
                "adapters/channel/protocol/index.js",
                "pilot/index.js",
                // 有意保留：edgeclaw-memory-core 独立子包，bundle 只打包 lib/
                "context/memory/edgeclaw-memory-core/lib/index.js",
              ],
            },
          ],
        },
      ],
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
    },
  },
);
