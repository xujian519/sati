import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackendCandidates,
  LIGHTPANDA_SESSION_POLICY,
  lightpandaChildEnv,
  resolveBrowserBackend,
  selectBackendForTask,
  type BackendRouteOptions,
  type BrowserTaskNeed,
} from "../../src/browser/backend/index.js";
import { LightpandaBackend } from "../../src/browser/backend/lightpandaBackend.js";

const DEFAULT_ORDER = ["ego", "browseros-neo", "browser-use", "playwright"];

function candidateIds(options?: BackendRouteOptions): string[] {
  return buildBackendCandidates(options).map(b => b.id);
}

test("browser backend: default cascade order matches the plan (ego → neo → browser-use → playwright)", () => {
  assert.deepEqual(candidateIds(), DEFAULT_ORDER);
});

test("browser backend: prefer lifts the preferred backend to the front", () => {
  assert.deepEqual(candidateIds({ prefer: "playwright" }), ["playwright", "ego", "browseros-neo", "browser-use"]);
  assert.deepEqual(candidateIds({ prefer: "browseros-neo" }), ["browseros-neo", "ego", "browser-use", "playwright"]);
});

test("browser backend: exclude removes candidates", () => {
  assert.deepEqual(candidateIds({ exclude: ["browseros-neo"] }), ["ego", "browser-use", "playwright"]);
  assert.deepEqual(candidateIds({ exclude: ["ego", "playwright"] }), ["browseros-neo", "browser-use"]);
});

test("browser backend: prefer of an excluded id degrades gracefully (exclude wins)", () => {
  // prefer 目标被 exclude 排除：exclude 优先，prefer 静默失效（有诊断输出）
  assert.deepEqual(candidateIds({ prefer: "browseros-neo", exclude: ["browseros-neo"] }), [
    "ego",
    "browser-use",
    "playwright",
  ]);
});

test("browser backend: capabilities reflect the POC mapping assessment", () => {
  const backends = buildBackendCandidates();
  const caps = Object.fromEntries(backends.map(b => [b.id, b.capabilities]));

  // ego: 全能力
  assert.equal(caps.ego.downloadInterception, true);
  assert.equal(caps.ego.screencast, true);
  assert.equal(caps.ego.handoff, true);
  assert.equal(caps.ego.siteTools, true);
  assert.equal(caps.ego.loginState, true);

  // BrowserOS neo: download/screencast 超集，handoff/siteTools 无对应
  assert.equal(caps["browseros-neo"].downloadInterception, true);
  assert.equal(caps["browseros-neo"].screencast, true);
  assert.equal(caps["browseros-neo"].handoff, false);
  assert.equal(caps["browseros-neo"].siteTools, false);
  assert.equal(caps["browseros-neo"].loginState, true);

  // browser-use: 登录态真，下载/录屏是已知短板（POC §3.2）
  assert.equal(caps["browser-use"].downloadInterception, false);
  assert.equal(caps["browser-use"].screencast, false);
  assert.equal(caps["browser-use"].loginState, true);

  // playwright: 兜底无登录态、非真实指纹；录屏有（browser_start_video）
  assert.equal(caps.playwright.loginState, false);
  assert.equal(caps.playwright.antiBot, false);
  assert.equal(caps.playwright.screencast, true);
});

test("browser backend: resolve is a cold decision that picks the first ok backend (no network dependency)", async () => {
  // 排除会真实发网络请求/探测的候选，保证确定性：
  // ego(linux 平台门禁 → missing) → playwright(builtin 插件存在 → ok)
  const backend = await resolveBrowserBackend({ platform: "linux", exclude: ["browseros-neo", "browser-use"] });
  assert.equal(backend.id, "playwright");
});

test("browser backend: resolve throws when every candidate is excluded (no backend)", async () => {
  await assert.rejects(
    resolveBrowserBackend({ platform: "linux", exclude: ["ego", "browseros-neo", "browser-use", "playwright"] }),
    /No browser backend available/,
  );
});

const LIGHTPANDA_BLOCKED_NEEDS = [
  "loginState",
  "antiBot",
  "pdf",
  "trueScreenshot",
  "handoff",
] as const satisfies readonly BrowserTaskNeed[];

test("browser backend: Lightpanda stays out of the default cascade and appends after playwright when opted in", () => {
  assert.deepEqual(candidateIds(), DEFAULT_ORDER);
  const optedIn = candidateIds({ includeLightpanda: true });
  assert.deepEqual(optedIn.slice(0, DEFAULT_ORDER.length), DEFAULT_ORDER);
  assert.equal(optedIn.at(-1), "lightpanda");
  assert.deepEqual(candidateIds({ prefer: "lightpanda" }), ["lightpanda", ...DEFAULT_ORDER]);
  assert.deepEqual(candidateIds({ prefer: "lightpanda", exclude: ["lightpanda"] }), DEFAULT_ORDER);
});

test("browser backend: Lightpanda is content-only (login, antiBot, PDF, true screenshot, handoff are false)", () => {
  const lightpanda = buildBackendCandidates({ includeLightpanda: true }).find(backend => backend.id === "lightpanda");
  assert.ok(lightpanda);
  assert.deepEqual(lightpanda.capabilities, {
    downloadInterception: false,
    screencast: false,
    handoff: false,
    siteTools: false,
    loginState: false,
    antiBot: false,
    contentCapable: true,
    pdf: false,
    trueScreenshot: false,
  });
});

test("browser backend: tasks that need login, PDF, antiBot, true screenshot, or handoff do not select Lightpanda", () => {
  const preferred = buildBackendCandidates({ includeLightpanda: true, prefer: "lightpanda" });
  for (const need of LIGHTPANDA_BLOCKED_NEEDS) {
    const picked = selectBackendForTask(preferred, { [need]: true });
    assert.notEqual(picked?.id, "lightpanda", need);
    assert.equal(picked?.id, "ego", need);
  }
  const contentDefault = selectBackendForTask(buildBackendCandidates({ includeLightpanda: true }), { content: true });
  assert.equal(contentDefault?.id, "ego");
  const contentPreferred = selectBackendForTask(preferred, { content: true });
  assert.equal(contentPreferred?.id, "lightpanda");
});

test("browser backend: a failed Lightpanda probe still falls through to the next capable backend", async () => {
  const backend = await resolveBrowserBackend({
    includeLightpanda: true,
    prefer: "lightpanda",
    needs: { content: true },
    platform: "linux",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaBin: "/no/such/lightpanda-binary",
  });
  assert.equal(backend.id, "playwright");
});

test("browser backend: login and PDF tasks skip Lightpanda even when its probe would succeed", async () => {
  let spawned = 0;
  for (const need of ["loginState", "pdf"] as const) {
    await assert.rejects(
      resolveBrowserBackend({
        prefer: "lightpanda",
        needs: { [need]: true },
        platform: "linux",
        exclude: ["browseros-neo", "browser-use"],
        lightpandaSpawn: () => {
          spawned += 1;
          return { status: 0, stdout: "nightly\n" };
        },
      }),
      /No browser backend/,
    );
  }
  assert.equal(spawned, 0);
});

test("browser backend: Lightpanda probe disables telemetry, pins no version, and does not touch ego cookies", async () => {
  assert.equal(LIGHTPANDA_SESSION_POLICY.telemetryDisabled, true);
  assert.equal(LIGHTPANDA_SESSION_POLICY.versionPin, null);
  assert.equal(LIGHTPANDA_SESSION_POLICY.cookieFile, null);
  assert.equal(LIGHTPANDA_SESSION_POLICY.cookieJar, null);
  assert.equal(LIGHTPANDA_SESSION_POLICY.sharesEgoProfile, false);
  assert.equal(lightpandaChildEnv({ PATH: "/usr/bin" }).LIGHTPANDA_DISABLE_TELEMETRY, "true");

  let captured: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  const backend = new LightpandaBackend({
    platform: "linux",
    bin: "lightpanda",
    spawnVersion: (bin, args, env) => {
      captured = { args: [bin, ...args], env };
      return { status: 0, stdout: "nightly\n" };
    },
  });
  const probe = await backend.probe();
  assert.equal(probe.status, "ok");
  assert.deepEqual(captured?.args, ["lightpanda", "version"]);
  assert.equal(captured?.env.LIGHTPANDA_DISABLE_TELEMETRY, "true");
  assert.equal(
    captured?.args.some(arg => arg.includes("cookie") || arg.includes("ego")),
    false,
  );

  let winSpawned = false;
  const windows = await new LightpandaBackend({
    platform: "win32",
    spawnVersion: () => {
      winSpawned = true;
      return { status: 0, stdout: "nightly\n" };
    },
  }).probe();
  assert.equal(winSpawned, false);
  assert.equal(windows.status, "missing");
});
