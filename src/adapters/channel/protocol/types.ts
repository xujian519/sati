import type { ChannelAttachment, Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { PolitConfig } from "../../../polit/index.js";

export type ChannelLogger = {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
};

export type ChannelStartDeps = {
  gateway: Gateway;
  config?: PolitConfig;
  logger?: ChannelLogger;
};

export type ChannelHandle = {
  stop(reason?: string): Promise<void>;
};

export interface ChannelAdapter {
  readonly channelKey: GatewayChannelKey;
  start(deps: ChannelStartDeps): Promise<ChannelHandle>;
}

export type ChannelMessage = {
  sessionKey: string;
  text: string;
  projectKey?: string;
  attachments?: ChannelAttachment[];
};
