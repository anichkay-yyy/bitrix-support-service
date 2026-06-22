import { bool, int, splitCsv, str } from "./utils.js";

export function loadConfig(env = process.env) {
  const classifierKbIds = splitCsv(env.CLASSIFIER_KB_IDS || env.FULL_KB_IDS);
  const replyKbIds = splitCsv(env.REPLY_KB_IDS || env.COMPACT_KB_IDS);
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

    assistantInternalUrl: str(env.ASSISTANT_INTERNAL_URL).replace(/\/+$/, ""),
    assistantInternalToken: str(env.ASSISTANT_INTERNAL_TOKEN),
    classifierKbIds: classifierKbIds.length > 0 ? classifierKbIds : ["e18766f6-f5cb-4cb6-92c0-7c6a39bb6cc3"],
    replyKbIds: replyKbIds.length > 0 ? replyKbIds : ["ac2af1fb-ba9d-4911-8d72-018467559f51"],
    supportKbIds: splitCsv(env.SUPPORT_KB_IDS),
    faqTopK: int(env.FAQ_TOP_K, 8, 1, 30),

    openrouterApiKey: str(env.OPENROUTER_API_KEY),
    openrouterModel: str(env.OPENROUTER_MODEL) || "z-ai/glm-5",

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
    kbConfigured:
      Boolean(config.assistantInternalUrl) &&
      (config.classifierKbIds.length > 0 || config.replyKbIds.length > 0 || config.supportKbIds.length > 0),
    classifierKbIds: config.classifierKbIds,
    replyKbIds: config.replyKbIds,
    llmConfigured: Boolean(config.openrouterApiKey),
    stateFile: config.stateFile,
    logFile: config.logFile || null,
  };
}
