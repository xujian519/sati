# Telemetry Receiver Contract (`analytics.v1`)

## Endpoint

- Method: `POST`
- Path: `/collect`
- Content-Type: `application/json`
- Body: `AnalyticsEvent[]`
- Success status: any `2xx`
- Deduplication key: `eventId`

## Delivery Semantics

- At-least-once delivery.
- Client batches events (default 20) and retries failed requests.
- Client persists unsent queue to local JSONL on shutdown and restores on startup.
- Receiver must handle duplicated events idempotently.

## Event Schema

```ts
type AnalyticsEvent = {
  schemaVersion: "analytics.v1";
  eventId: string;
  eventName: "app_started" | "feature_used" | "error_occurred" | "session_active";
  occurredAt: string; // ISO timestamp
  installationId: string; // installation-level identity (stable across shared server-token)
  instanceId: string; // instance-level identity (distinguishes multi-instance same machine)
  deploymentMode:
    | "source"
    | "docker"
    | "curl_installer"
    | "desktop_installer"
    | "npm_binary"
    | "unknown";
  sessionId?: string;
  commitHash: string; // app/runtime commit hash
  appVersion: string;
  platform: string; // process.platform
  projectPath?: string;
  properties: Record<string, unknown>;
};
```

## Breaking Change Note

- Removed field: `projectCommitHash`.

## `feature_used` Two-Layer Model

For `eventName = "feature_used"`, `properties` follows:

```ts
type FeatureUsedProperties = {
  module: "router" | "always_on" | "memory" | "cron_job" | "session";
  loopStage:
    | "module_event"
    | "loop_start"
    | "model_request"
    | "model_response"
    | "tool_prepare"
    | "tool_call"
    | "permission_check"
    | "loop_end";
  outcome?: "success" | "failed" | "aborted" | "timeout" | "denied";
  errorCategory?:
    | "model_request_error"
    | "permission_error"
    | "tool_param_error"
    | "tool_runtime_error"
    | "tool_result_parse_error"
    | "loop_error"
    | "runtime_error";
  // plus module-specific metadata
  [key: string]: unknown;
};
```

## `error_occurred` Properties

- `module`: same module space as above plus runtime/ui contexts.
- `loopStage`: where the error occurred.
- `errorCategory`: normalized category.
- `code`: error code (if available).
- `message`: truncated message.
- `stack`: sanitized/truncated stack (optional).
- Additional context fields are allowed.

## Aggregation Guidance

- Installation-level active users (DAU): distinct `installationId` per day.
- Instance-level active users: distinct `instanceId` per day.
- Module metrics: group by `properties.module`.
- Loop-stage funnel/error rates: group by `properties.module + properties.loopStage + properties.outcome`.
