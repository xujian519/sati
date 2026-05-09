import type {
  Gateway,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
} from "../protocol/types.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronStopInput,
  CronStopResult,
} from "../../cron/protocol/types.js";
import { GatewayWsClient } from "./GatewayWsClient.js";

export class RemoteGateway implements Gateway {
  constructor(private readonly client: GatewayWsClient) {}

  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    return this.client.stream("submit_turn", input);
  }

  async abortTurn(input: { sessionKey: string; runId?: string }): Promise<void> {
    await this.client.request("abort_turn", input);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return (await this.client.request("list_sessions", input)) as ListSessionsResult;
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return (await this.client.request("resume_session", input)) as { sessionKey: string };
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    return (await this.client.request("new_session", input)) as { sessionKey: string };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.client.request("close_session", input);
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return (await this.client.request("describe_server", {})) as GatewayServerInfo;
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return (await this.client.request("cron_create", input)) as CronCreateResult;
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return (await this.client.request("cron_list", input)) as CronListResult;
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return (await this.client.request("cron_delete", input)) as CronDeleteResult;
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return (await this.client.request("cron_stop", input)) as CronStopResult;
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    return (await this.client.request("elicitation_respond", input)) as { delivered: boolean };
  }
}

export async function createRemoteGateway(options: ConstructorParameters<typeof GatewayWsClient>[0]): Promise<RemoteGateway> {
  const client = new GatewayWsClient(options);
  await client.connect();
  return new RemoteGateway(client);
}
