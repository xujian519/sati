export { createGateway, type CreateGatewayOptions, type GatewayProjectStorageOptions } from "./Gateway.js";
export {
  SessionRouter,
  type GatewaySessionContext,
  type GatewaySessionFactory,
  type SessionRouterOptions,
} from "./SessionRouter.js";
export { InProcessGateway, mapAgentEvent, type InProcessGatewayOptions } from "./client/InProcessGateway.js";
export { GatewayWsClient, type GatewayWsClientOptions } from "./client/GatewayWsClient.js";
export { RemoteGateway, createRemoteGateway } from "./client/RemoteGateway.js";
export { connectRemoteGatewayIfAvailable, probeGatewayServer, type ProbeGatewayServerOptions } from "./client/probeServer.js";
export { startGatewayServer, type GatewayServer, type GatewayServerOptions } from "./server/GatewayServer.js";
export {
  ensureGatewayAuthToken,
  readGatewayAuthToken,
  resolveGatewayTokenPath,
  type GatewayAuthTokenOptions,
} from "./server/authToken.js";
export type {
  ChannelAttachment,
  Gateway,
  GatewayChannelKey,
  GatewayError,
  GatewayEvent,
  GatewayMode,
  GatewayServerInfo,
  GatewaySessionInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  TurnUsage,
} from "./protocol/index.js";
export type {
  GatewayWsClientName,
  WsEventFrame,
  WsGatewayFrame,
  WsGatewayMethod,
  WsHelloFrame,
  WsHelloOk,
  WsRequestFrame,
  WsResponseFrame,
} from "./protocol/index.js";
export { POLITDECK_GATEWAY_PROTOCOL_VERSION } from "./protocol/index.js";
