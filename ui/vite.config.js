import path from "path";
import fs from "fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { getConnectableHost, normalizeLoopbackHost } from "./shared/networkHosts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
// 应用版本号唯一来源 = 根 package.json#version（与 apps/desktop/package.json 同步 bump，
// 见 apps/desktop/RELEASING.md「版本号 lockstep」）。注入浏览器侧 gateway 客户端的
// clientVersion（src/web/client/GatewayBrowserClient.ts 消费 __SATI_APP_VERSION__）。
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, "package.json"), "utf8"));

export default defineConfig(({ mode }) => {
  // Load the single root .env and let exported shell vars override file values.
  const env = {
    ...loadEnv(mode, repoRoot, ""),
    ...process.env,
  };

  const configuredHost = env.HOST || "0.0.0.0";
  // if the host is not a loopback address, it should be used directly.
  // This allows the vite server to EXPOSE all interfaces when the host
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost);

  const proxyHost = env.PROXY_HOST || getConnectableHost(configuredHost);
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001;
  const localNodeModules = (...segments) => path.resolve(process.cwd(), "node_modules", ...segments);

  const disableLocalAuth = env.SATI_DISABLE_LOCAL_AUTH !== "0" && env.SATI_DISABLE_LOCAL_AUTH !== "false";

  return {
    define: {
      "import.meta.env.VITE_DISABLE_LOCAL_AUTH": JSON.stringify(disableLocalAuth ? "true" : "false"),
      __SATI_APP_VERSION__: JSON.stringify(rootPkg.version),
    },
    plugins: [react()],
    resolve: {
      alias: {
        // 浏览器侧 gateway 客户端（src/web/client）唯一接入点——CLAUDE.md「ui/ 不得直接导入 src/」的豁免项
        "@sati/web-client": path.resolve(repoRoot, "src", "web", "client"),
        react: localNodeModules("react"),
        "react-dom": localNodeModules("react-dom"),
        "react/jsx-runtime": localNodeModules("react", "jsx-runtime.js"),
        "react/jsx-dev-runtime": localNodeModules("react", "jsx-dev-runtime.js"),
      },
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        "/api": `http://${proxyHost}:${serverPort}`,
        "/memory-dashboard": `http://${proxyHost}:${serverPort}`,
        "/ws": {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        "/shell": {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
    build: {
      outDir: "dist",
      // 2.3MB 主包在 1000KB 阈值下不告警；降到 500KB 让体积问题在构建时可见
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          // vite 8 (rolldown) requires manualChunks to be a function;
          // the object form is no longer accepted.
          manualChunks(id) {
            if (!id.includes("/node_modules/")) return undefined;
            const match = pkg => id.includes(`/node_modules/${pkg}/`);
            if (["react", "react-dom", "react-router-dom"].some(match)) return "vendor-react";
            if (
              [
                "@uiw/react-codemirror",
                "@codemirror/lang-css",
                "@codemirror/lang-html",
                "@codemirror/lang-javascript",
                "@codemirror/lang-json",
                "@codemirror/lang-markdown",
                "@codemirror/lang-python",
                "@codemirror/theme-one-dark",
              ].some(match)
            ) {
              return "vendor-codemirror";
            }
            if (["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-clipboard", "@xterm/addon-webgl"].some(match)) {
              return "vendor-xterm";
            }
            return undefined;
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: [path.resolve(__dirname, "../vitest.setup.ts")],
      // e2e/ is Playwright-only; vitest would otherwise pick up *.spec.mjs
      // files there and fail to run them.
      exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
      server: {
        deps: {
          inline: ["react", "react-dom"],
        },
      },
    },
  };
});
