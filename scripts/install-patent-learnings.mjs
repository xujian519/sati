#!/usr/bin/env node
/**
 * 安装 google-patents learnings 站点包到本机 ego-browser 技能目录。
 *
 * ego-browser harness 从以下根目录读取 learnings（按 `siteSkillsRoot` 探测顺序）：
 *   1. `EGO_BROWSER_AGENT_WORKSPACE` 环境变量指向的目录（若设置）
 *   2. bundle 旁的 `skills/ego-browser/learnings`（ego lite app 自带，只读）
 *   3. 各 agent 技能目录（~/.grok/skills、~/.claude/skills、~/.agents/skills 等）
 *
 * 本脚本把仓库内 `skills/ego-browser/learnings/google-patents/` 复制到所有
 * 存在的候选根目录，幂等（先删后拷）。用法：
 *   node scripts/install-patent-learnings.mjs
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(repoRoot, "skills", "ego-browser", "learnings", "google-patents");

if (!existsSync(join(source, "manifest.json"))) {
  console.error(`source learnings not found: ${source}`);
  process.exit(1);
}

const home = homedir();
const workspaceOverride = process.env.EGO_BROWSER_AGENT_WORKSPACE;

/** 候选 learnings 根目录（存在才安装）。 */
function candidateRoots() {
  const roots = [];
  if (workspaceOverride) roots.push(join(workspaceOverride, "learnings"));
  roots.push(
    join(home, ".grok", "skills", "ego-browser", "learnings"),
    join(home, ".claude", "skills", "ego-browser", "learnings"),
    join(home, ".agents", "skills", "patent-legal", "ego-browser", "learnings"),
  );
  return roots.filter(root => existsSync(root));
}

let installed = 0;
for (const root of candidateRoots()) {
  const dest = join(root, "google-patents");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });
  console.log(`installed → ${dest}`);
  installed += 1;
}

if (installed === 0) {
  console.log("no learnings root found; install ego lite first, or set EGO_BROWSER_AGENT_WORKSPACE.");
}
