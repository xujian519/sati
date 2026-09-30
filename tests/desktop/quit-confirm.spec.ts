import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQuitPrompt, resolveQuitAction } from "../../apps/desktop/src/quit-confirm.js";

// Electron 主进程的退出闸门拆成纯函数（判定表 + 文案），这里覆盖它们；
// 真正的 Electron 接线（before-quit / 托盘菜单 / 对话框）无法在没有桌面运行时的
// 环境下断言，改动时刻意保持接线只有一处调用点。
const BASE = { shutdownStarted: false, promptOpen: false, confirmed: false, skipConfirmation: false };

describe("resolveQuitAction", () => {
  it("首次退出请求先确认", () => {
    assert.equal(resolveQuitAction(BASE), "confirm");
  });

  it("用户确认后放行关停", () => {
    assert.equal(resolveQuitAction({ ...BASE, confirmed: true }), "shutdown");
  });

  it("程序化退出（启动失败 / 无托盘兜底）不确认", () => {
    assert.equal(resolveQuitAction({ ...BASE, skipConfirmation: true }), "shutdown");
  });

  it("确认框开着时忽略重复请求（连按 Cmd+Q 不叠框）", () => {
    assert.equal(resolveQuitAction({ ...BASE, promptOpen: true }), "ignore");
  });

  it("关停已开始时忽略后续请求（避免杀子进程到一半就退出留孤儿）", () => {
    assert.equal(resolveQuitAction({ ...BASE, shutdownStarted: true, confirmed: true }), "ignore");
    assert.equal(resolveQuitAction({ ...BASE, shutdownStarted: true }), "ignore");
  });
});

describe("buildQuitPrompt", () => {
  it("两种语言都把默认键与取消键设为取消（误触的代价更大）", () => {
    for (const zh of [true, false]) {
      const prompt = buildQuitPrompt(zh);
      assert.equal(prompt.defaultId, 1);
      assert.equal(prompt.cancelId, 1);
      assert.equal(prompt.buttons.length, 2);
      assert.equal(prompt.buttons[prompt.defaultId], zh ? "取消" : "Cancel");
      assert.match(prompt.detail, zh ? /关闭主窗口/ : /close the main window/);
    }
  });

  it("两种语言的文案都非空且互不相同", () => {
    const zh = buildQuitPrompt(true);
    const en = buildQuitPrompt(false);
    assert.ok(zh.message.length > 0 && en.message.length > 0);
    assert.notEqual(zh.message, en.message);
    assert.notEqual(zh.buttons[0], en.buttons[0]);
  });
});
