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
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/no-contradicting-classname": "warn",
      // Disabled: the v4 plugin's fixes are not value-preserving — it rewrites
      // text-[11px] -> text-xxs (adds a line-height) and text-[14px] ->
      // text-xxs--line-height (an invalid class name), changing rendered output.
      "tailwindcss/no-unnecessary-arbitrary-value": "off",

      // --- Disabled base rules ---
      // no-explicit-any: warn 而非 off —— 与根 eslint.config.mjs 保持一致，存量 any 可见、增量收敛。
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // ui/server 边界：禁止直接导入 src/ 内部实现（CLAUDE.md「ui/ 不得直接导入 src/」）。
    // 白名单 = 现存迁移中的合法入口；每个条目收敛后（走 gateway 协议或 barrel）即从 except 摘除。
    // 新增的 ui/server → src/ 导入会被拦截（error）。
    files: ["server/**/*.{js,mjs}"],
    plugins: { "import-x": importX },
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./server",
              from: "../src",
              except: [
                // src/cli/proxy.js (pilotdeck-bridge.js:47, sati-bridge.js:47)
                "cli/proxy.js",
                // src/gateway/index.js (pilotdeck-bridge.js:56, sati-bridge.js:57)
                "gateway/index.js",
                // src/status/agentStatus.js (pilotdeck-bridge.js:57, sati-bridge.js:58)
                "status/agentStatus.js",
                // src/web/client/eventMapping.js — 共享 GatewayEvent→帧映射
                // (pilotdeck-bridge.js / sati-bridge.js / ui/src/chat 浏览器直连共用一份)
                "web/client/eventMapping.js",
                // src/web/server/legacySessionPresentation.js (projects.js:26)
                "web/server/legacySessionPresentation.js",
                // src/cron/protocol/types.js (projects.js:33)
                "cron/protocol/types.js",
                // src/context/budget/compactBudget.js (sati-bridge.js:48)
                "context/budget/compactBudget.js",
                // src/context/memory/edgeclaw-memory-core/lib/index.js (routes/memory.js:5)
                "context/memory/edgeclaw-memory-core/lib/index.js",
                // src/model/providerEndpoint.js (routes/config.js:30)
                "model/providerEndpoint.js",
                // src/network/fetch.js (routes/config.js:31)
                "network/fetch.js",
                // src/adapters/channel/protocol/ChannelCommandRegistry.js (routes/commands.js:14)
                "adapters/channel/protocol/ChannelCommandRegistry.js",
                // src/cli/commands/chatSearch.js (routes/commands.js:15)
                "cli/commands/chatSearch.js",
                // src/pilot/config/parseGatewayConfig.js (services/satiConfig.js:6, services/pilotdeckConfig.js:6)
                "pilot/config/parseGatewayConfig.js",
              ],
            },
          ],
        },
      ],
    },
  },
);
