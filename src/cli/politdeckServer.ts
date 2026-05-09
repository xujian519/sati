import { FeishuChannel } from "../adapters/index.js";
import type { Gateway } from "../gateway/index.js";
import { startGatewayServer, type GatewayServer } from "../gateway/index.js";

export type StartPolitDeckServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  staticAssetsPath?: string;
  feishu?: FeishuChannel;
};

export async function startPolitDeckServer(options: StartPolitDeckServerOptions): Promise<GatewayServer> {
  await options.feishu?.start({ gateway: options.gateway });
  return startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    staticAssetsPath: options.staticAssetsPath,
    feishuWebhook: options.feishu
      ? (request, response, body) => options.feishu!.handleWebhook(request, response, body)
      : undefined,
  });
}
