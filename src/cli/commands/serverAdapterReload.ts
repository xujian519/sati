/**
 * IM 适配器热重载（P2.7 从 `cli/sati.ts` 的 `main` 内嵌闭包原样搬出，逐 token 未改）。
 *
 * 触发点：`sati.yaml` 的 `adapters.*` 变更（`handleAdapterHotReload`），以及 UI「重新登录」
 * 按钮经 `prepare_weixin_login` 走扫码流程（`hotStartWeixinChannel({forceRelogin:true})`）。
 * 未监听成功的 server（`state.server` 为空）一律早退——启动期配置变更不产生副作用。
 */

import { loadEnabledChannels } from "../../adapters/index.js";
import type { ChannelStatePersistence } from "../../adapters/index.js";
import type { PilotConfig } from "../../pilot/index.js";
import { logger } from "../../telemetry/index.js";
import { buildFeishuChannel, buildQqChannel, buildWeComChannel, buildWeixinChannel } from "./serverChannels.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

export type AdapterHotReload = {
  hotStartWeixinChannel(options?: { forceRelogin?: boolean }): Promise<void>;
  handleAdapterHotReload(config: PilotConfig): Promise<void>;
};

export function createAdapterHotReload(deps: {
  state: ServerRuntimeState;
  persistence: ChannelStatePersistence;
}): AdapterHotReload {
  const { state, persistence } = deps;

  async function hotStartWeixinChannel(options: { forceRelogin?: boolean } = {}): Promise<void> {
    if (!state.server) return;
    await state.server.hotStartChannel(await buildWeixinChannel(persistence, options.forceRelogin ?? false));
  }

  async function handleAdapterHotReload(config: PilotConfig): Promise<void> {
    if (!state.server) return;
    const parts: string[] = [];

    const feishuChannel = await buildFeishuChannel(config.adapters, persistence);
    if (feishuChannel) {
      await state.server.hotStartChannel(feishuChannel);
      parts.push("feishu=started");
    }

    const wCfg = config.adapters?.weixin;
    if (wCfg?.enabled === true) {
      await hotStartWeixinChannel();
      parts.push("weixin=started");
    }

    const qqChannel = await buildQqChannel(config.adapters, persistence);
    if (qqChannel) {
      await state.server.hotStartChannel(qqChannel);
      parts.push("qq=started");
    }

    const wecomChannel = await buildWeComChannel(config.adapters, persistence);
    if (wecomChannel) {
      await state.server.hotStartChannel(wecomChannel);
      parts.push("wecom=started");
    }

    const extraChannels = await loadEnabledChannels(config.adapters);
    for (const ch of extraChannels) {
      await state.server.hotStartChannel(ch);
      parts.push(`${ch.channelKey}=started`);
    }

    if (parts.length) {
      logger.info(`Adapter hot-reload complete: ${parts.join(", ")}`);
    }
  }

  return { hotStartWeixinChannel, handleAdapterHotReload };
}
