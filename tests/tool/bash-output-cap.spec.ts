import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CappedStreamCapture } from "../../src/tool/builtin/bash/commandRunner.js";

/**
 * 回归覆盖（PR #804 审查）：bash 子进程输出必须在采集阶段就有上限。
 * 之前 `NodeShellCommandRunner` 把 stdout/stderr 整段累加进字符串，
 * `cat 大日志` / `yes` 这类命令会在超时前把主进程撑到 OOM；工具侧
 * 的 maxResultBytes 只是事后截断，救不了已经分配的缓冲。
 *
 * 这里用小上限（head 4 / tail 4）验证真正的截断语义：保留开头与结尾，
 * 中间丢弃，并显式标注省略量（不得静默丢数据）。
 */

describe("CappedStreamCapture", () => {
  it("未超限时原样保留全部输出", () => {
    const capture = new CappedStreamCapture(4, 4);
    capture.append("abc");
    capture.append("def");
    assert.equal(capture.text(), "abcdef");
  });

  it("超限时保留头尾并标注省略字符数", () => {
    const capture = new CappedStreamCapture(4, 4);
    capture.append("HEAD");
    capture.append("0123456789");
    capture.append("TAIL");
    const text = capture.text();

    assert.ok(text.startsWith("HEAD"), `expected head preserved, got: ${text}`);
    assert.ok(text.endsWith("TAIL"), `expected tail preserved, got: ${text}`);
    assert.match(text, /characters omitted/);
    // 中间内容必须被丢弃，不能静默留在结果里。
    assert.ok(!text.includes("0123456789"), `middle content should be dropped, got: ${text}`);
  });

  it("分块顺序不影响截断后的排列（头在前、尾在后）", () => {
    const capture = new CappedStreamCapture(3, 3);
    capture.append("AAA");
    capture.append("BBB");
    capture.append("CCC");
    capture.append("DDD");
    const text = capture.text();
    assert.ok(text.startsWith("AAA"));
    assert.ok(text.endsWith("DDD"));
    // 省略量应真实反映被丢弃的字符数（"BB" + "CCC" 中的部分）。
    assert.match(text, /[0-9]+ characters omitted/);
  });
});
