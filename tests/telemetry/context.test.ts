import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveTelemetryRuntimeContext } from "../../src/telemetry/context.js";

test("runtime context includes deploymentMode and instanceId", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-telemetry-context-"));
  const tokenPath = join(pilotHome, "server-token");
  writeFileSync(tokenPath, "token-for-installation\n", "utf8");

  const context = resolveTelemetryRuntimeContext({
    pilotHome,
    env: {
      PILOT_HOME: pilotHome,
      COMMIT_HASH: "deadbeef",
      PILOTDECK_VERSION: "1.2.3",
    },
  });

  assert.equal(context.commitHash, "deadbeef");
  assert.equal(context.appVersion, "1.2.3");
  assert.ok(context.installationId.length > 0);
  assert.ok(context.instanceId.length > 0);
  assert.ok(context.deploymentMode.length > 0);

  rmSync(pilotHome, { recursive: true, force: true });
});
