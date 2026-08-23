import type {
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  AlwaysOnListPlansInput,
  AlwaysOnListPlansResult,
  AlwaysOnReadReportInput,
  AlwaysOnReadReportResult,
  AlwaysOnListCyclesInput,
  AlwaysOnListCyclesResult,
  AlwaysOnArchiveCycleInput,
  AlwaysOnArchiveCycleResult,
  AlwaysOnApplyCycleInput,
  AlwaysOnApplyCycleResult,
  Gateway,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  PrepareWeixinLoginResult,
  ReloadConfigResult,
  ReloadExtensionsInput,
  ReloadExtensionsResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  KnowledgeCapabilitiesInput,
  KnowledgeCapabilitiesResult,
} from "../protocol/types.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../../extension/skills/types.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../../cron/protocol/types.js";
import { parseReloadConfigResult } from "../protocol/reloadConfigResult.js";
import { GatewayWsClient, type GatewayWsNotificationHandler } from "./GatewayWsClient.js";

export class RemoteGateway implements Gateway {
  constructor(private readonly client: GatewayWsClient) {}

  onNotification(handler: GatewayWsNotificationHandler): void {
    this.client.onNotification(handler);
  }

  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    return this.client.stream("submit_turn", input);
  }

  async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
    await this.client.request("abort_turn", input);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.client.request<ListSessionsResult>("list_sessions", input);
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return this.client.request<{ sessionKey: string }>("resume_session", input);
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    return this.client.request<{ sessionKey: string }>("new_session", input);
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.client.request("close_session", input);
  }

  async recordAgentStatusMessage(
    input: import("../protocol/types.js").GatewayRecordAgentStatusMessageInput,
  ): Promise<{ recorded: boolean }> {
    return this.client.request<{ recorded: boolean }>("record_agent_status_message", input);
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return this.client.request<GatewayServerInfo>("describe_server", {});
  }

  async getActiveTurnSnapshot(
    input: import("../protocol/types.js").GatewayActiveTurnSnapshotInput,
  ): Promise<import("../protocol/types.js").GatewayActiveTurnSnapshot> {
    return this.client.request<import("../protocol/types.js").GatewayActiveTurnSnapshot>("active_turn_snapshot", input);
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return this.client.request<CronCreateResult>("cron_create", input);
  }

  async cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult> {
    return this.client.request<CronUpdateResult>("cron_update", input);
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return this.client.request<CronListResult>("cron_list", input);
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return this.client.request<CronDeleteResult>("cron_delete", input);
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return this.client.request<CronStopResult>("cron_stop", input);
  }

  async cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    return this.client.request<CronRunNowResult>("cron_run_now", input);
  }

  async panelHeartbeat(input: { sessionKeys: string[] }): Promise<{ touched: number }> {
    return this.client.request<{ touched: number }>("panel_heartbeat", input);
  }

  async teamPanelSnapshot(input: { sessionKey?: string }): Promise<{ teams: unknown[] }> {
    return this.client.request<{ teams: unknown[] }>("team_panel_snapshot", input);
  }

  async teamToolCall(input: {
    tool: string;
    input: Record<string, unknown>;
    sessionKey?: string;
  }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
    return this.client.request<{
      ok: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    }>("team_tool_call", input);
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    return this.client.request<{ delivered: boolean }>("elicitation_respond", input);
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    return this.client.request<{ delivered: boolean }>("permission_decide", input);
  }

  async grantSessionPermission(
    input: import("../protocol/types.js").GatewaySessionPermissionGrantInput,
  ): Promise<{ granted: boolean; entry?: string }> {
    return this.client.request<{ granted: boolean; entry?: string }>("grant_session_permission", input);
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    return this.client.request<WebReadSessionMessagesResult>("read_session_messages", input);
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    return this.client.request<WebReadSubagentMessagesResult>("read_subagent_messages", input);
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    return this.client.request<WebForkSessionResult>("fork_session", input);
  }

  async listProjects(): Promise<WebListProjectsResult> {
    return this.client.request<WebListProjectsResult>("list_projects", {});
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    return this.client.request<WebProjectSummary>("describe_project", input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    return parseReloadConfigResult(await this.client.request("reload_config", {}));
  }

  async prepareWeixinLogin(): Promise<PrepareWeixinLoginResult> {
    return this.client.request<PrepareWeixinLoginResult>("prepare_weixin_login", {});
  }

  async reloadExtensions(input: ReloadExtensionsInput = {}): Promise<ReloadExtensionsResult> {
    return this.client.request<ReloadExtensionsResult>("reload_extensions", input);
  }

  async skillsList(input: SkillsListInput): Promise<SkillsListResult> {
    return this.client.request<SkillsListResult>("skill_list", input);
  }

  async skillRead(input: SkillAddressInput): Promise<SkillReadResult> {
    return this.client.request<SkillReadResult>("skill_read", input);
  }

  async skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
    return this.client.request<SkillWriteResult>("skill_write", input);
  }

  async skillCreate(input: SkillCreateInput): Promise<SkillCreateResult> {
    return this.client.request<SkillCreateResult>("skill_create", input);
  }

  async skillDelete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    return this.client.request<SkillDeleteResult>("skill_delete", input);
  }

  async skillImport(input: SkillImportInput): Promise<SkillImportResult> {
    return this.client.request<SkillImportResult>("skill_import", input);
  }

  async skillValidate(input: SkillValidateInput): Promise<SkillValidationResult> {
    return this.client.request<SkillValidationResult>("skill_validate", input);
  }

  async skillScan(input: SkillScanInput): Promise<SkillScanResult> {
    return this.client.request<SkillScanResult>("skill_scan", input);
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    return this.client.request<AlwaysOnApplyResult>("always_on_apply", input);
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    return this.client.request<AlwaysOnRerunPlanResult>("always_on_rerun_plan", input);
  }

  async alwaysOnListPlans(input: AlwaysOnListPlansInput): Promise<AlwaysOnListPlansResult> {
    return this.client.request<AlwaysOnListPlansResult>("always_on_list_plans", input);
  }

  async alwaysOnReadReport(input: AlwaysOnReadReportInput): Promise<AlwaysOnReadReportResult> {
    return this.client.request<AlwaysOnReadReportResult>("always_on_read_report", input);
  }

  async alwaysOnListCycles(input: AlwaysOnListCyclesInput): Promise<AlwaysOnListCyclesResult> {
    return this.client.request<AlwaysOnListCyclesResult>("always_on_list_cycles", input);
  }

  async alwaysOnArchiveCycle(input: AlwaysOnArchiveCycleInput): Promise<AlwaysOnArchiveCycleResult> {
    return this.client.request<AlwaysOnArchiveCycleResult>("always_on_archive_cycle", input);
  }

  async alwaysOnApplyCycle(input: AlwaysOnApplyCycleInput): Promise<AlwaysOnApplyCycleResult> {
    return this.client.request<AlwaysOnApplyCycleResult>("always_on_apply_cycle", input);
  }

  async knowledgeCapabilities(input: KnowledgeCapabilitiesInput): Promise<KnowledgeCapabilitiesResult> {
    return this.client.request<KnowledgeCapabilitiesResult>("knowledge_capabilities", input);
  }
}

export async function createRemoteGateway(
  options: ConstructorParameters<typeof GatewayWsClient>[0],
): Promise<RemoteGateway> {
  const client = new GatewayWsClient(options);
  await client.connect();
  return new RemoteGateway(client);
}
