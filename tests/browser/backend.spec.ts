import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackendCandidates,
  resolveBrowserBackend,
  type BackendRouteOptions,
} from "../../src/browser/backend/index.js";

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
