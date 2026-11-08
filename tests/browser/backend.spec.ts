import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserNeedsError,
  buildBackendCandidates,
  fetchBrowserContent,
  LIGHTPANDA_SESSION_POLICY,
  LIGHTPANDA_VERSION_PIN,
  lightpandaChildEnv,
  resolveBrowserBackend,
  selectBackendForTask,
  type BackendRouteOptions,
  type BrowserContentOutcome,
  type BrowserTaskNeed,
} from "../../src/browser/backend/index.js";
import { LightpandaBackend, LightpandaContentError } from "../../src/browser/backend/lightpandaBackend.js";

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

test("browser backend: Lightpanda probe disables telemetry, matches the release pin, and does not touch ego cookies", async () => {
  assert.equal(LIGHTPANDA_VERSION_PIN, "1.0.3");
  assert.equal(LIGHTPANDA_SESSION_POLICY.telemetryDisabled, true);
  assert.equal(LIGHTPANDA_SESSION_POLICY.versionPin, "1.0.3");
  assert.equal(LIGHTPANDA_SESSION_POLICY.cookieFile, null);
  assert.equal(LIGHTPANDA_SESSION_POLICY.cookieJar, null);
  assert.equal(LIGHTPANDA_SESSION_POLICY.sharesEgoProfile, false);
  assert.equal(
    lightpandaChildEnv({ PATH: "/usr/bin", LIGHTPANDA_DISABLE_TELEMETRY: "false" }).LIGHTPANDA_DISABLE_TELEMETRY,
    "true",
  );

  const mismatched = await new LightpandaBackend({
    platform: "linux",
    bin: "lightpanda",
    spawnVersion: () => ({ status: 0, stdout: "nightly\n" }),
  }).probe();
  assert.equal(mismatched.status, "warn");
  assert.match(mismatched.detail, /1\.0\.3/);
  assert.match(mismatched.detail, /does not download/);

  let captured: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  const backend = new LightpandaBackend({
    platform: "linux",
    bin: "lightpanda",
    spawnVersion: (bin, args, env) => {
      captured = { args: [bin, ...args], env };
      return { status: 0, stdout: "1.0.3\n" };
    },
  });
  const probe = await backend.probe();
  assert.equal(probe.status, "ok");
  assert.equal(probe.detail, "1.0.3");
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

const MARKDOWN_REQUEST = { url: "https://example.com/docs", format: "markdown" as const };
const MARKDOWN_DUMP = "# Example\n\nHello\n";

function pinnedVersion(): { status: 0; stdout: string; stderr: string } {
  return { status: 0, stdout: `${LIGHTPANDA_VERSION_PIN}\n`, stderr: "" };
}

test("browser backend: Lightpanda selection rejects a call that does not pass needs", async () => {
  const preferred = buildBackendCandidates({ includeLightpanda: true, prefer: "lightpanda" });
  assert.throws(() => selectBackendForTask(preferred), BrowserNeedsError);
  assert.throws(() => selectBackendForTask(preferred, {}), BrowserNeedsError);

  let spawned = 0;
  await assert.rejects(
    () =>
      resolveBrowserBackend({
        includeLightpanda: true,
        prefer: "lightpanda",
        platform: "linux",
        lightpandaSpawn: () => {
          spawned += 1;
          return pinnedVersion();
        },
      }),
    BrowserNeedsError,
  );
  await assert.rejects(
    () => fetchBrowserContent(MARKDOWN_REQUEST, { prefer: "lightpanda", platform: "linux" }),
    BrowserNeedsError,
  );
  assert.equal(spawned, 0);
});

test("browser backend: Lightpanda markdown fetch is opt-in, pinned, telemetry-off, and cookie-free", async () => {
  const egoCookie = "/tmp/ego-profile/cookies.json";
  const previousTelemetry = process.env.LIGHTPANDA_DISABLE_TELEMETRY;
  const previousEgo = process.env.EGO_COOKIE_FILE;
  process.env.LIGHTPANDA_DISABLE_TELEMETRY = "false";
  process.env.EGO_COOKIE_FILE = egoCookie;
  let captured: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  try {
    const outcome = await fetchBrowserContent(MARKDOWN_REQUEST, {
      includeLightpanda: true,
      prefer: "lightpanda",
      needs: { content: true },
      platform: "linux",
      exclude: ["browseros-neo", "browser-use"],
      lightpandaSpawn: () => pinnedVersion(),
      lightpandaRun: (bin, args, env) => {
        captured = { args: [bin, ...args], env };
        return { status: 0, stdout: MARKDOWN_DUMP, stderr: "" };
      },
    });
    assert.equal(outcome.kind, "lightpanda");
    if (outcome.kind !== "lightpanda") return;
    assert.equal(outcome.content.format, "markdown");
    assert.equal(outcome.content.dump, "markdown");
    assert.equal(outcome.content.text, MARKDOWN_DUMP);
    assert.equal(outcome.content.structured, undefined);
    assert.deepEqual(captured?.args, [
      "lightpanda",
      "fetch",
      "--dump",
      "markdown",
      "--fail-on-http-error",
      "--log-level",
      "error",
      "--terminate-ms",
      "15000",
      "--obey-robots",
      MARKDOWN_REQUEST.url,
    ]);
    assert.equal(captured?.env.LIGHTPANDA_DISABLE_TELEMETRY, "true");
    assert.equal(captured?.args.includes("--cookie"), false);
    assert.equal(captured?.args.includes("--cookie-jar"), false);
    assert.equal(captured?.args.includes("--http-cache-dir"), false);
    assert.equal(captured?.args.includes(egoCookie), false);
    assert.equal(captured?.args.includes("pdf"), false);
    assert.equal(captured?.args.includes("png"), false);
  } finally {
    if (previousTelemetry === undefined) delete process.env.LIGHTPANDA_DISABLE_TELEMETRY;
    else process.env.LIGHTPANDA_DISABLE_TELEMETRY = previousTelemetry;
    if (previousEgo === undefined) delete process.env.EGO_COOKIE_FILE;
    else process.env.EGO_COOKIE_FILE = previousEgo;
  }
});

test("browser backend: Lightpanda structured extract returns parsed JSON and does not dump pdf or png", async () => {
  const payload = { jsonLd: [{ "@type": "Article", headline: "Example" }], openGraph: { title: "Example" } };
  let dump: string | undefined;
  const outcome = await fetchBrowserContent(
    { url: "https://example.com/article", format: "structured" },
    {
      prefer: "lightpanda",
      needs: { content: true },
      platform: "linux",
      exclude: ["browseros-neo", "browser-use"],
      lightpandaSpawn: () => pinnedVersion(),
      lightpandaRun: (_bin, args) => {
        dump = args[args.indexOf("--dump") + 1];
        return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
      },
    },
  );
  assert.equal(outcome.kind, "lightpanda");
  if (outcome.kind !== "lightpanda") return;
  assert.equal(dump, "structured_data");
  assert.deepEqual(outcome.content.structured, payload);
  assert.equal(outcome.content.dump, "structured_data");
});

test("browser backend: login, PDF, antiBot, screenshot, and handoff still skip Lightpanda before fetch", async () => {
  let spawned = 0;
  for (const need of LIGHTPANDA_BLOCKED_NEEDS) {
    await assert.rejects(
      () =>
        fetchBrowserContent(MARKDOWN_REQUEST, {
          prefer: "lightpanda",
          needs: { content: true, [need]: true },
          platform: "linux",
          lightpandaSpawn: () => {
            spawned += 1;
            return pinnedVersion();
          },
          lightpandaRun: () => {
            spawned += 1;
            return { status: 0, stdout: MARKDOWN_DUMP, stderr: "" };
          },
        }),
      BrowserNeedsError,
    );
  }
  assert.equal(spawned, 0);
});

test("browser backend: content routing keeps Lightpanda behind the default cascade unless prefer is set", async () => {
  let runs = 0;
  const run = () => {
    runs += 1;
    return { status: 0, stdout: MARKDOWN_DUMP, stderr: "" };
  };
  const untouched = await fetchBrowserContent(MARKDOWN_REQUEST, {
    needs: { content: true },
    platform: "linux",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaSpawn: () => pinnedVersion(),
    lightpandaRun: run,
  });
  const optedIn = await fetchBrowserContent(MARKDOWN_REQUEST, {
    includeLightpanda: true,
    needs: { content: true },
    platform: "linux",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaSpawn: () => pinnedVersion(),
    lightpandaRun: run,
  });
  assert.equal(runs, 0);
  assert.equal(untouched.kind, "cascade");
  assert.equal(optedIn.kind, "cascade");
  if (untouched.kind !== "cascade" || optedIn.kind !== "cascade") return;
  assert.equal(untouched.backend.id, "playwright");
  assert.equal(untouched.reason, "selected-other-backend");
  assert.equal(optedIn.backend.id, "playwright");
});

test("browser backend: a version mismatch or content failure continues to the next candidate", async () => {
  let runs = 0;
  const mismatched: BrowserContentOutcome = await fetchBrowserContent(MARKDOWN_REQUEST, {
    includeLightpanda: true,
    prefer: "lightpanda",
    needs: { content: true },
    platform: "linux",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaSpawn: () => ({ status: 0, stdout: "1.0.2\n", stderr: "" }),
    lightpandaRun: () => {
      runs += 1;
      return { status: 0, stdout: MARKDOWN_DUMP, stderr: "" };
    },
  });
  assert.equal(runs, 0);
  assert.equal(mismatched.kind, "cascade");
  if (mismatched.kind !== "cascade") return;
  assert.equal(mismatched.backend.id, "playwright");
  assert.equal(mismatched.reason, "selected-other-backend");

  const failed = await fetchBrowserContent(MARKDOWN_REQUEST, {
    prefer: "lightpanda",
    needs: { content: true },
    platform: "linux",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaSpawn: () => pinnedVersion(),
    lightpandaRun: () => ({ status: 22, stdout: "# Error page\n", stderr: "http 404" }),
  });
  if (failed.kind !== "cascade" || failed.reason !== "lightpanda-content-failed") {
    assert.fail("expected the HTTP error page to fall through, not to be returned as content");
  }
  assert.equal(failed.backend.id, "playwright");
  assert.equal(failed.cause.exitStatus, 22);
  assert.match(failed.cause.message, /fetch failed/);
  assert.equal(failed.cause.message.includes("# Error page"), false);

  const invalidStructured = await fetchBrowserContent(
    { url: "https://example.com/article", format: "structured" },
    {
      prefer: "lightpanda",
      needs: { content: true },
      platform: "linux",
      exclude: ["browseros-neo", "browser-use"],
      lightpandaSpawn: () => pinnedVersion(),
      lightpandaRun: () => ({ status: 0, stdout: "{", stderr: "" }),
    },
  );
  if (invalidStructured.kind !== "cascade" || invalidStructured.reason !== "lightpanda-content-failed") {
    assert.fail("expected invalid structured JSON to fall through");
  }
  assert.match(invalidStructured.cause.message, /not valid JSON/);
});

test("browser backend: content failure with no later backend throws instead of returning an empty page", async () => {
  await assert.rejects(
    () =>
      fetchBrowserContent(MARKDOWN_REQUEST, {
        prefer: "lightpanda",
        needs: { content: true },
        platform: "linux",
        exclude: ["ego", "browseros-neo", "browser-use", "playwright"],
        lightpandaSpawn: () => pinnedVersion(),
        lightpandaRun: () => ({ status: 1, stdout: "# Error page\n", stderr: "navigation failed" }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof LightpandaContentError);
      assert.match(error.message, /fetch failed/);
      assert.match(error.message, /no later browser backend/);
      assert.equal(error.message.includes("# Error page"), false);
      return true;
    },
  );
});

test("browser backend: non-http content URLs and win32 do not launch a Lightpanda fetch", async () => {
  let runs = 0;
  const run = () => {
    runs += 1;
    return { status: 0, stdout: MARKDOWN_DUMP, stderr: "" };
  };
  await assert.rejects(
    () =>
      fetchBrowserContent(
        { url: "file:///etc/passwd", format: "markdown" },
        {
          prefer: "lightpanda",
          needs: { content: true },
          platform: "linux",
          lightpandaSpawn: () => pinnedVersion(),
          lightpandaRun: run,
        },
      ),
    LightpandaContentError,
  );
  const windows = await fetchBrowserContent(MARKDOWN_REQUEST, {
    prefer: "lightpanda",
    needs: { content: true },
    platform: "win32",
    exclude: ["browseros-neo", "browser-use"],
    lightpandaSpawn: () => pinnedVersion(),
    lightpandaRun: run,
  });
  assert.equal(runs, 0);
  assert.equal(windows.kind, "cascade");
  if (windows.kind !== "cascade") return;
  assert.notEqual(windows.backend.id, "lightpanda");
});
