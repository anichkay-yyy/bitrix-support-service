import { bool, int, splitCsv, str } from "./utils.js";

export function loadConfig(env = process.env) {
  return {
    host: str(env.HOST) || "0.0.0.0",
    port: int(env.PORT, 3900, 1, 65535),
    dryRun: bool(env.DRY_RUN, true),
    pollEnabled: bool(env.POLL_ENABLED, false),
    pollIntervalMs: int(env.POLL_INTERVAL_MS, 60_000, 5_000),
    markProcessedInDryRun: bool(env.MARK_PROCESSED_IN_DRY_RUN, false),

    workflowId:
      str(env.WORKFLOW_ID || env.BITRIX_WORKFLOW_ID || env.SANDBOX_WORKFLOW_ID) ||
      "9d0e5a79-c89f-4782-8419-0cb3ef9180f2",
    workflowName: str(env.WORKFLOW_NAME) || "Support AI Agent - Bitrix Standalone",
    instanceId: str(env.INSTANCE_ID) || "inst_bitrix_support_standalone",

    bitrixWebhookUrl: str(env.BITRIX_WEBHOOK_URL),
    bitrixApplicationToken: str(env.BITRIX_APPLICATION_TOKEN || env.APPLICATION_TOKEN),
    bitrixLeadStatusId: str(env.BITRIX_LEAD_STATUS_ID) || "NEW",
    bitrixMaxLeads: int(env.BITRIX_MAX_LEADS, 50, 1, 500),
    bitrixAnswerStatusId: str(env.BITRIX_ANSWER_STATUS_ID),
    bitrixAnswerStatusTitle: str(env.BITRIX_ANSWER_STATUS_TITLE),
    excludedLeadIds: new Set(splitCsv(env.EXCLUDED_LEAD_IDS)),
    excludedSourceIds: new Set(splitCsv(env.EXCLUDED_SOURCE_IDS)),

    orderStatusServiceUrl: str(env.ORDER_STATUS_SERVICE_URL).replace(/\/+$/, ""),
    allowReceivedReply: bool(env.ALLOW_RECEIVED_REPLY, false),

    stateFile: str(env.STATE_FILE) || "./data/state.json",
    logFile: str(env.LOG_FILE) || "",
  };
}

export function publicConfig(config) {
  return {
    host: config.host,
    port: config.port,
    dryRun: config.dryRun,
    pollEnabled: config.pollEnabled,
    pollIntervalMs: config.pollIntervalMs,
    workflowId: config.workflowId,
    workflowName: config.workflowName,
    instanceId: config.instanceId,
    bitrixConfigured: Boolean(config.bitrixWebhookUrl),
    bitrixLeadStatusId: config.bitrixLeadStatusId,
    bitrixMaxLeads: config.bitrixMaxLeads,
    orderStatusConfigured: Boolean(config.orderStatusServiceUrl),
    stateFile: config.stateFile,
    logFile: config.logFile || null,
  };
}
