/**
 * 外部依赖的 **CI 信号守卫**。
 *
 * 为什么单列一条：依赖真实外部二进制的用例（`dot.spec.ts` 与 `svg-safety.spec.ts` 的
 * graphviz 通路）在缺依赖时**整组 `skip`**，而运行日志读起来仍然是绿的——「CI 上一直只是
 * 几条跳过」会把「没跑」伪装成「通过」，整条链路长期无信号却没人发现。
 *
 * 本文件在 CI 上断言依赖确实装好了：装不上就红，逼着把依赖装进镜像
 * （`.github/workflows/ci.yml` 已安装 graphviz），而不是让跳过静默通过。
 *
 * 非 CI 环境不设门槛（本机没装 graphviz 是正常状态）；这是**有意**的 skip，与上面说的
 * 「无信号的跳过」不同：它的判据是环境而非依赖可用性，且 CI 上必然执行。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveDotBinary } from "../../../src/patent/figuregen/render-graphviz.js";

/** 是否在 CI 中运行（GitHub Actions 会设 CI=true）。 */
const onCi = process.env.CI === "true" || process.env.CI === "1";

test("CI 信号：graphviz dot 必须真的可用（那几条真机用例的跳过是「无信号」而不是「通过」）", {
  skip: onCi ? false : "非 CI 环境，不对本机依赖设门槛",
}, () => {
  const dot = resolveDotBinary();
  assert.notEqual(
    dot,
    null,
    "CI 镜像里没有 graphviz dot：真机 graphviz 用例会整组跳过，等于这条链路在 CI 上从未被验证。" +
      "请在 .github/workflows/ci.yml 安装 graphviz，而不是接受这个静默。",
  );
  assert.ok(String(dot).length > 0);
});
