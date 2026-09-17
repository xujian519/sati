/**
 * TD-TEAM-N11（issue #353 载体，台账 §团队 N11）：`runMemberScan` 的**整体失败**必须留痕。
 *
 * 该处是 **promise 链上的 `.catch()`**，不是 `catch {}` 子句——所以它既不被
 * `scripts/measure-techdebt.mjs` 的「无注释的无参 catch」口径统计，也不是补一行注释
 * 能治的：它的危害是**返回值不可区分**。扫描整体失败与「确实没有可恢复成员」都返回
 * `{scanned: 0, resumed: 0}`，没有日志时队长侧看到的完全一样——成员断点整批不复跑，
 * 却看起来一切正常（冷恢复静默失效）。同文件 `startStartupScan` 的同类失败（`:255`）
 * 本来就打 `logger.error`，同一失败域两种待遇。
 *
 * 两个测试构成一对判据：
 * 1. 失败路径：db 关闭使 `listMembers()` 抛错 ⇒ 返回零值**且**记 error 日志；
 * 2. 正常空扫描：新建团队库、无成员 ⇒ 同样返回零值但**不**记 error。
 * 只测第 1 条无法证明日志是「失败」的信号（也可能是每次都打），只测第 2 条无法证明
 * 失败被观测；两条一起才钉住「同返回值、不同信号」这个不变量。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTeamSubsystem, type TeamSubsystemRuntime } from "../../src/cli/teamSubsystem.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { SessionPresence } from "../../src/gateway/server/sessionPresence.js";
import { logger } from "../../src/telemetry/index.js";

/** 建一个只依赖 tmp pilotHome 的子系统（构造期不触碰 gateway 方法，见 TeamSubsystemDeps）。 */
function makeSubsystem(t: { after: (fn: () => void) => void }): TeamSubsystemRuntime {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-team-scan-"));
  const runtime = buildTeamSubsystem({
    pilotHome,
    env: {},
    gateway: new InProcessGateway({} as SessionRouter, {}),
    fallbackProjectRoot: pilotHome,
    sessionPresence: new SessionPresence(),
    mailboxLeaseMs: undefined,
  });
  t.after(() => {
    runtime.db.close();
    rmSync(pilotHome, { recursive: true, force: true });
  });
  return runtime;
}

test("runMemberScan：扫描整体失败时返回零值——但必须记 error 日志（TD-TEAM-N11）", async t => {
  const runtime = makeSubsystem(t);
  const errors: unknown[][] = [];
  // 捕获 logger.error 的首参（不落真实 stderr，避免污染测试输出）。
  t.mock.method(logger, "error", (...args: unknown[]) => {
    errors.push(args);
  });

  // 让扫描整体失败：关闭 db 后 `scanTeamMembers` 首行 `db.listMembers()` 抛错，
  // 于是进 `.catch`（这正是「冷恢复整批失效」的形态，与「无成员」不可区分）。
  runtime.db.close();

  const result = await runtime.runMemberScan();

  assert.deepEqual(result, { scanned: 0, resumed: 0 }, "失败路径的返回值与正常路径一致（这是必须靠日志区分的原因）");
  assert.equal(errors.length, 1, "整体失败必须记恰好一条 error，否则队长侧零信号");
  assert.match(String(errors[0]?.[0]), /Team member scan failed/);
  assert.ok(errors[0]?.[1] instanceof Error, "日志必须带上原始 error 对象，便于定位失败原因");
});

test("runMemberScan：无成员可恢复的正常空扫描不记 error（日志是失败信号，不是每次都打）", async t => {
  const runtime = makeSubsystem(t);
  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => {
    errors.push(args);
  });

  const result = await runtime.runMemberScan();

  assert.deepEqual(result, { scanned: 0, resumed: 0 });
  assert.equal(errors.length, 0, "空仓库的正常扫描不应产出 error 日志：否则该日志失去「失败」的判别力");
});
