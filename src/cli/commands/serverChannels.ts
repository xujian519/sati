/**
 * IM 渠道构造器（P2.7 从 `cli/sati.ts` 的 `main` 内嵌闭包原样搬出，逐 token 未改）。
 *
 * 启动与适配器热重载共用同一组构造器：`adapters.*.enabled !== true` 一律返回 `undefined`
 * （调用方据此跳过启动），微信（iLink）无 enabled 开关故恒返回实例，扫码登录状态经
 * `onStateChange` 回写 `ChannelStatePersistence`，重启后由 `mapper` 恢复会话映射。
 */

import {
  type ChannelStatePersistence,
  FeishuChannel,
  FeishuSessionMapper,
  type FeishuSessionMapperState,
  QQChannel,
  QQSessionMapper,
  type QQSessionMapperState,
  WeComChannel,
  WeComSessionMapper,
  type WeComSessionMapperState,
  WeixinChannel,
  WeixinSessionMapper,
  type WeixinSessionMapperState,
} from "../../adapters/index.js";
import type { PilotAdaptersConfig } from "../../pilot/index.js";

/**
 * Build a Feishu/Lark channel from the loaded adapter config.
 * Returns undefined when the adapter is disabled.
 */
export async function buildFeishuChannel(
  adapters: PilotAdaptersConfig | undefined,
  persistence: ChannelStatePersistence,
): Promise<FeishuChannel | undefined> {
  const cfg = adapters?.feishu;
  if (cfg?.enabled !== true) return undefined;
  const saved = await persistence.load<FeishuSessionMapperState>("feishu");
  return new FeishuChannel({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    encryptKey: cfg.encryptKey,
    verifyToken: cfg.verifyToken,
    connectionMode: cfg.connectionMode,
    domainName: cfg.domainName,
    mapper: saved ? new FeishuSessionMapper(saved) : undefined,
    onStateChange: state => persistence.save("feishu", state),
  });
}

/** Build a Weixin (iLink) channel, restoring persisted session state. */
export async function buildWeixinChannel(
  persistence: ChannelStatePersistence,
  forceRelogin = false,
): Promise<WeixinChannel> {
  const saved = await persistence.load<WeixinSessionMapperState>("weixin");
  return new WeixinChannel({
    forceRelogin,
    mapper: saved ? new WeixinSessionMapper(saved) : undefined,
    onStateChange: state => persistence.save("weixin", state),
  });
}

/** Build a QQ channel from the loaded adapter config. Returns undefined when disabled. */
export async function buildQqChannel(
  adapters: PilotAdaptersConfig | undefined,
  persistence: ChannelStatePersistence,
): Promise<QQChannel | undefined> {
  const cfg = adapters?.qq;
  if (cfg?.enabled !== true) return undefined;
  const saved = await persistence.load<QQSessionMapperState>("qq");
  return new QQChannel({
    appId: cfg.appId,
    clientSecret: cfg.clientSecret,
    allowGroups: cfg.allowGroups,
    triggerPrefixes: cfg.triggerPrefixes,
    maxMessageLength: cfg.maxMessageLength,
    mapper: saved ? new QQSessionMapper(saved) : undefined,
    onStateChange: state => persistence.save("qq", state),
  });
}

/** Build a WeCom channel from the loaded adapter config. Returns undefined when disabled. */
export async function buildWeComChannel(
  adapters: PilotAdaptersConfig | undefined,
  persistence: ChannelStatePersistence,
): Promise<WeComChannel | undefined> {
  const cfg = adapters?.wecom;
  if (cfg?.enabled !== true) return undefined;
  const saved = await persistence.load<WeComSessionMapperState>("wecom");
  return new WeComChannel({
    botKey: cfg.token,
    extra: cfg.extra,
    mapper: saved ? new WeComSessionMapper(saved) : undefined,
    onStateChange: state => persistence.save("wecom", state),
  });
}
