import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidCronTimezone, resolveCronTimezone } from "../../src/cron/CronTimezone.js";

describe("isValidCronTimezone", () => {
  it("识别合法 IANA 时区", () => {
    assert.equal(isValidCronTimezone("UTC"), true);
    assert.equal(isValidCronTimezone("Asia/Shanghai"), true);
    assert.equal(isValidCronTimezone("America/New_York"), true);
  });

  it("拒绝非法时区", () => {
    assert.equal(isValidCronTimezone("Not/AZone"), false);
    assert.equal(isValidCronTimezone(""), false);
    assert.equal(isValidCronTimezone("UTC+8"), false);
  });
});

describe("resolveCronTimezone", () => {
  it("按 schedule → task → config → UTC 优先级解析", () => {
    assert.equal(resolveCronTimezone("Asia/Shanghai", "UTC", "UTC"), "Asia/Shanghai");
    assert.equal(resolveCronTimezone(undefined, "Asia/Tokyo", "UTC"), "Asia/Tokyo");
    assert.equal(resolveCronTimezone(undefined, undefined, "Europe/Berlin"), "Europe/Berlin");
    assert.equal(resolveCronTimezone(undefined, undefined, undefined), "UTC");
  });

  it("跳过非法值并回退到下一优先级", () => {
    assert.equal(resolveCronTimezone("Bad/Zone", "Asia/Shanghai", "UTC"), "Asia/Shanghai");
    assert.equal(resolveCronTimezone("Bad/Zone", "Bad/Zone", "UTC"), "UTC");
  });
});
