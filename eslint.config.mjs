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
      "src/context/memory/edgeclaw-memory-core/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "tests/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "apps/desktop/scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
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
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
];
