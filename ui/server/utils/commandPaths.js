/**
 * Shared path policy for the `/api/commands/*` routes.
 *
 * Before this module existed, `/api/commands/load` and `/api/commands/execute`
 * each carried their own (and crucially, different) check for the same
 * "command / skill file path" parameter: `/load` accepted anything under
 * `$HOME`, `/execute` used a directory whitelist. The divergence meant the
 * weaker route could read arbitrary files in the user's home directory
 * (`~/.ssh/id_rsa`, `~/.aws/credentials`, …). Both routes now resolve the
 * parameter through `resolveCommandPath()` so the boundary can only be
 * relaxed in one place — and relaxing it is then a visible, reviewable edit.
 *
 * `/api/commands/load` has since been retired (zero consumers, see #356), so
 * `resolveCommandPath()` now serves `/api/commands/execute` only.
 *
 * See `docs/notes/implemented/2026-09-14-command-path-whitelist.md`.
 */
import path from "node:path";
import { resolvePilotHome } from "./pilotPaths.js";

/** Message used by the commands routes so operators see one wording for one policy. */
export const COMMAND_PATH_DENIED_MESSAGE = "Command must be in a .sati/commands or .sati/skills directory";

/**
 * Directories a command / skill file may live in.
 *
 * The Sati home scopes are always allowed. Project-scoped scopes are only
 * added when the caller supplies `context.projectPath` — a request without
 * project context gets the strictly smaller set.
 *
 * @param {{ projectPath?: string } | undefined} [context]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]} Absolute directory paths.
 */
export function commandAllowedBases(context, env = process.env) {
  const pilotHome = resolvePilotHome(env);
  const bases = [path.resolve(path.join(pilotHome, "commands")), path.resolve(path.join(pilotHome, "skills"))];

  if (context?.projectPath) {
    bases.push(
      path.resolve(path.join(context.projectPath, ".sati", "commands")),
      path.resolve(path.join(context.projectPath, ".sati", "skills")),
    );
  }

  return bases;
}

/**
 * True when `target` is a strict descendant of `base`.
 *
 * The base directory itself is rejected (`rel === ""`) — callers must point at
 * a file, not a directory. `..foo` style names are *not* mistaken for a
 * traversal: only a leading `..` path segment counts.
 *
 * @param {string} base Absolute directory path.
 * @param {string} target Absolute path to test.
 * @returns {boolean}
 */
export function isUnderBase(base, target) {
  const rel = path.relative(base, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve `commandPath` and enforce the whitelist in one step.
 *
 * @param {unknown} commandPath Raw value from the request body.
 * @param {{ projectPath?: string } | undefined} [context]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null} Absolute path when allowed, `null` otherwise.
 */
export function resolveCommandPath(commandPath, context, env = process.env) {
  if (typeof commandPath !== "string" || commandPath.trim() === "") return null;

  const resolvedPath = path.resolve(commandPath);
  const allowed = commandAllowedBases(context, env).some(base => isUnderBase(base, resolvedPath));

  return allowed ? resolvedPath : null;
}
