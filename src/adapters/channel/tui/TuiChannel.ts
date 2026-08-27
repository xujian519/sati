import { spawn } from "node:child_process";
import React from "react";
import { render, type Instance } from "ink";
import type { Gateway } from "../../../gateway/index.js";
import { connectRemoteGatewayIfAvailable, type ProbeGatewayServerOptions } from "../../../gateway/client/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { applyTuiEvent, createTuiRenderState, type TuiRenderState } from "./tui-render.js";
import { defaultTuiSessionKey } from "./app/sessionKey.js";
import { TuiApp, type TuiAppProps } from "./app/TuiApp.js";

export type TuiChannelOptions = {
  projectKey?: string;
  sessionKey?: string;
  /** auto 模式下远端探测配置；false = 跳过探测，直接用本地 gateway。 */
  probe?: ProbeGatewayServerOptions | false;
  model?: string;
  cwd?: string;
  serverUrl?: string;
  interactive?: boolean;
  /**
   * 连接模式（缺省 "auto"）：
   * - "auto"：内部探测远端 server，未命中回退本地 gateway；
   * - "remote"：host 已预探测并传入远端 gateway，跳过内部探测；
   * - "in_process"：host 已构建本地 gateway，跳过内部探测。
   */
  mode?: "auto" | "remote" | "in_process";
};

export class TuiChannel implements ChannelAdapter {
  readonly channelKey = "tui";
  readonly state: TuiRenderState = createTuiRenderState();
  private stopped = false;
  private instance?: Instance;

  constructor(private readonly options: TuiChannelOptions = {}) {}

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    const { gateway, connection } = await this.resolveGateway(deps.gateway);
    if (this.options.interactive === false) {
      return { stop: async () => this.stop() };
    }

    const appProps: TuiAppProps = {
      gateway,
      connection,
      projectKey: this.options.projectKey,
      sessionKey: this.options.sessionKey,
      model: this.options.model,
      cwd: this.options.cwd,
      serverUrl:
        this.options.serverUrl ??
        (connection === "remote"
          ? this.options.probe && typeof this.options.probe === "object"
            ? this.options.probe.url
            : undefined
          : undefined),
      onViewOutput: async (path: string) => {
        this.instance?.unmount();
        const pager = process.env.PAGER || "less";
        try {
          const child = spawn(pager, [path], { stdio: "inherit" });
          await new Promise<void>(resolve => child.on("exit", () => resolve()));
        } catch {
          /* pager failed, continue */
        }
        this.instance = render(React.createElement(TuiApp, appProps));
      },
    };

    this.instance = render(React.createElement(TuiApp, appProps));
    await this.instance.waitUntilExit();
    return { stop: async () => this.stop() };
  }

  async submit(gateway: Gateway, message: string): Promise<TuiRenderState> {
    for await (const event of gateway.submitTurn({
      sessionKey: this.options.sessionKey ?? defaultTuiSessionKey(this.options.projectKey),
      channelKey: "tui",
      projectKey: this.options.projectKey,
      message,
    })) {
      applyTuiEvent(this.state, event);
    }
    return this.state;
  }

  private async resolveGateway(gateway: Gateway): Promise<{ gateway: Gateway; connection: "remote" | "in_process" }> {
    // host 已决定连接目标时（mode 非 auto），传入的 gateway 即最终 gateway。
    const mode = this.options.mode ?? "auto";
    if (mode === "remote" || mode === "in_process") {
      return { gateway, connection: mode };
    }
    if (this.options.probe === false) {
      return { gateway, connection: "in_process" };
    }
    const remote = await connectRemoteGatewayIfAvailable({ ...this.options.probe, timeoutMs: 200 });
    return remote ? { gateway: remote, connection: "remote" } : { gateway, connection: "in_process" };
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.instance?.unmount();
  }
}

// 缺省会话键实现移入叶子模块 app/sessionKey.js（打破 TuiChannel ↔ TuiApp 值循环），
// 此处保持再导出以维持既有公共导入面（adapters/index.ts 等）。
export { defaultTuiSessionKey } from "./app/sessionKey.js";
