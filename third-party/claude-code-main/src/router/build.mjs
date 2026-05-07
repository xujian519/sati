#!/usr/bin/env node

/**
 * Build script for the embedded CCR (Claude Code Router).
 *
 * Bundles src/server.ts + shared/ into a single server.cjs file.
 * Runnable via: node build.mjs   (or: bun build.mjs)
 *
 * Path aliases handled:
 *   @/*         -> src/*
 *   @CCR/shared -> shared/index.ts  (inlined into the bundle)
 *
 * Externals (resolved from claude-code-main node_modules at runtime):
 *   fastify, @fastify/cors, dotenv, undici, tiktoken, lru-cache
 */

import { build } from "esbuild";
import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Path-alias plugin (resolves @/* -> src/*) ──

function pathAliasPlugin(aliases, baseUrl) {
  return {
    name: "path-alias",
    setup(b) {
      for (const [pattern, target] of Object.entries(aliases)) {
        const prefix = pattern.replace(/\/\*$/, "");
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        b.onResolve({ filter: new RegExp(`^${escaped}/`) }, (args) => {
          const rest = args.path.replace(new RegExp(`^${escaped}/`), "");
          const noExt = rest.replace(/\.[^.]+$/, "");
          const resolved = resolve(baseUrl, target.replace(/\*$/, ""), noExt);

          const exts = [".ts", ".tsx", ".js", ".jsx", ".json"];
          for (const ext of exts) {
            const p = resolved + ext;
            if (existsSync(p) && statSync(p).isFile()) return { path: p };
          }
          if (existsSync(resolved) && statSync(resolved).isDirectory()) {
            for (const ext of exts) {
              const idx = join(resolved, `index${ext}`);
              if (existsSync(idx) && statSync(idx).isFile()) return { path: idx };
            }
          }
          return { path: resolved + ".ts" };
        });
      }
    },
  };
}

// ── @CCR/shared resolver (inline into bundle) ──

function sharedAliasPlugin(sharedDir) {
  return {
    name: "ccr-shared-alias",
    setup(b) {
      b.onResolve({ filter: /^@CCR\/shared$/ }, () => ({
        path: resolve(sharedDir, "index.ts"),
      }));
      b.onResolve({ filter: /^@CCR\/shared\// }, (args) => {
        const rest = args.path.replace(/^@CCR\/shared\//, "");
        return { path: resolve(sharedDir, rest) };
      });
    },
  };
}

// ── Build ──

const srcDir = join(__dirname, "src");
const sharedDir = join(__dirname, "shared");

const t0 = Date.now();

await build({
  entryPoints: [join(srcDir, "server.ts")],
  outdir: __dirname,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: [
    "fastify",
    "dotenv",
    "@fastify/cors",
    "undici",
    "tiktoken",
    "lru-cache",
  ],
  plugins: [
    sharedAliasPlugin(sharedDir),
    pathAliasPlugin({ "@/*": "src/*" }, __dirname),
  ],
});

const elapsed = Date.now() - t0;
console.log(`[CCR build] server.cjs built in ${elapsed}ms`);
