import { hashText, normalizeText, str } from "./utils.js";
import {
  faqHandler,
  needReplyGate,
  orderStatusHandler,
  simpleReply,
  templateHandler,
  validateAnswer,
} from "./handlers.js";
import { chatIdFromPayload, leadIdFromPayload, messageIdFromPayload, textFromPayload } from "./bitrix.js";

export class SupportFlow {
  constructor({ config, logger, state, bitrix, orderStatusClient, kbClient, llmClient }) {
    this.config = config;
    this.logger = logger;
    this.state = state;
    this.bitrix = bitrix;
    this.orderStatusClient = orderStatusClient;
    this.kbClient = kbClient;
    this.llmClient = llmClient;
    this.emit = () => {};
  }

  setEventSink(fn) {
    this.emit = typeof fn === "function" ? fn : () => {};
  }

  async tick() {
    if (!this.config.bitrixWebhookUrl) throw new Error("BITRIX_WEBHOOK_URL is not configured");
    await this.state.increment("ticks");
    const leads = await this.bitrix.listLeads();
    const results = [];
    for (const lead of leads) {
      const leadId = str(lead.ID ?? lead.id);
      if (this.config.excludedLeadIds.has(leadId)) {
        results.push({ leadId, action: "skip", reason: "excluded_lead" });
        continue;
      }
      const sourceId = str(lead.SOURCE_ID ?? lead.sourceId);
      if (sourceId && this.config.excludedSourceIds.has(sourceId)) {
        results.push({ leadId, action: "skip", reason: "excluded_source" });
        continue;
      }
      try {
        const context = await this.bitrix.contextForLead(lead);
        results.push(await this.processCase(context));
      } catch (err) {
        await this.state.increment("errors");
        await this.logger.error("flow.lead_error", { leadId, error: err.message });
        results.push({ leadId, action: "error", error: err.message });
      }
    }
    return { ok: true, leads: leads.length, results };
  }

  async analyzePayload(payload) {
    if (this.config.bitrixApplicationToken) {
      const actual = String(
        payload?.auth?.application_token ??
          payload?.auth?.APPLICATION_TOKEN ??
          payload?.application_token ??
          payload?.APPLICATION_TOKEN ??
          "",
      ).trim();
      if (actual !== this.config.bitrixApplicationToken) {
        return { action: "skip", reason: "invalid_application_token" };
      }
    }
    const context = this.config.bitrixWebhookUrl
      ? await this.bitrix.contextFromPayload(payload)
      : fallbackContextFromPayload(payload);
    return this.processCase(context);
  }

  async analyzeText(input) {
    return this.processCase({
      leadId: str(input.lead_id ?? input.leadId),
      chatId: str(input.chat_id ?? input.chatId),
      messageId: str(input.message_id ?? input.messageId),
      text: str(input.text),
      lead: {},
      messages: Array.isArray(input.messages) ? input.messages : [{ role: "user", text: str(input.text) }],
      lastUserMessage: { id: str(input.message_id ?? input.messageId), role: "user", text: str(input.text) },
      previewOnly: input.preview_only ?? input.previewOnly ?? true,
    });
  }

  async processCase(context) {
    const leadId = str(context.leadId);
    const chatId = str(context.chatId);
    const text = str(context.text);
    const key = this.caseKey(context);

    this.emit({ type: "run_start", input: { text, from: context.from || chatId || leadId } });
    this.emit({ type: "message_in", from: context.from || chatId || leadId, text });

    if (context.skipReason)
      return this.finish(context, key, { action: "skip", reason: context.skipReason, handler: "bitrix_ingest" });
    if (!text) return this.finish(context, key, { action: "skip", reason: "empty_text", handler: "need_reply_gate" });
    if (this.state.hasProcessed(key)) return { leadId, chatId, key, action: "skip", reason: "already_processed" };

    await this.state.increment("analyzed");

    let result = needReplyGate(text);
    if (!result) {
      result = simpleReply(text);
      if (result)
        this.emit({
          type: "route_decision",
          nodeId: "simple_reply_gate",
          edgeLabel: "yes",
          textPreview: result.answer,
        });
    }
    if (!result) {
      result = await orderStatusHandler({ text, orderStatusClient: this.orderStatusClient });
      if (result)
        this.emit({
          type: "node_done",
          nodeId: "order_info_agent",
          nodeType: "custom-agent",
          outputPreview: result.answer || result.reason,
        });
    }
    if (!result) result = templateHandler(text);
    if (!result) {
      result = await faqHandler({
        text,
        contextMessages: context.messages || [],
        kbClient: this.kbClient,
        llmClient: this.llmClient,
      });
      this.emit({
        type: "node_done",
        nodeId: result.handler || "reply_generator",
        nodeType: "custom-agent",
        outputPreview: result.answer || result.reason,
      });
    }

    result = validateAnswer(result);
    return this.finish(context, key, result);
  }

  async finish(context, key, result) {
    const leadId = str(context.leadId);
    const chatId = str(context.chatId);
    const dryRun = Boolean(context.previewOnly) || this.config.dryRun;
    const answerPreview = result.answer ? normalizeText(result.answer).slice(0, 500) : "";
    const entry = {
      key,
      leadId,
      chatId,
      messageId: str(context.messageId),
      textHash: hashText(context.text),
      action: result.action,
      reason: result.reason,
      handler: result.handler,
      answerPreview,
      dryRun,
      previewOnly: Boolean(context.previewOnly),
      details: result,
    };

    if (result.action !== "reply") {
      await this.state.increment("skipped");
      await this.state.recordAnswer(entry);
      await this.logger.info("flow.skip", entry);
      this.emit({
        type: "branch_stop",
        nodeId: result.handler || "pipeline",
        nodeType: "service",
        reason: result.reason,
        textPreview: context.text,
      });
      if (!context.previewOnly && (!dryRun || this.config.markProcessedInDryRun))
        await this.state.markProcessed(key, entry);
      return entry;
    }

    if (dryRun) {
      await this.state.recordAnswer(entry);
      await this.logger.info("flow.dry_reply", entry);
      this.emit({ type: "message_out", to: chatId || leadId, text: result.answer });
      if (!context.previewOnly && this.config.markProcessedInDryRun) await this.state.markProcessed(key, entry);
      return { ...entry, answer: result.answer };
    }

    const send = await this.bitrix.sendOpenLineMessage({
      leadId,
      chatId,
      userId: str(context.lead?.ASSIGNED_BY_ID ?? context.lead?.assignedById),
      text: result.answer,
      nextStatusId: result.nextStatusId,
      nextStatusTitle: result.nextStatusTitle,
      nextStatusReason: result.nextStatusReason,
    });
    let statusUpdate = null;
    const statusId = result.nextStatusId || this.config.bitrixAnswerStatusId;
    if (statusId) {
      statusUpdate = await this.bitrix.updateLeadStatus(leadId, statusId);
    }
    await this.state.increment("replied");
    await this.state.recordAnswer({ ...entry, send, statusUpdate });
    await this.state.markProcessed(key, { ...entry, send, statusUpdate });
    await this.logger.info("flow.sent", { ...entry, send, statusUpdate });
    this.emit({ type: "message_out", to: chatId || leadId, text: result.answer });
    return { ...entry, send, statusUpdate };
  }

  caseKey(context) {
    const leadId = str(context.leadId) || "unknown-lead";
    const chatId = str(context.chatId) || "unknown-chat";
    const messageId = str(context.messageId || context.lastUserMessage?.id);
    return `bitrix:${leadId}:${chatId}:${messageId || hashText(context.text)}`;
  }
}

function fallbackContextFromPayload(payload) {
  const leadId = leadIdFromPayload(payload);
  const chatId = chatIdFromPayload(payload);
  const messageId = messageIdFromPayload(payload);
  const text = textFromPayload(payload);
  return {
    leadId,
    chatId,
    messageId,
    text,
    from: chatId || leadId,
    lead: {},
    messages: [{ id: messageId, role: "user", text }],
    lastUserMessage: { id: messageId, role: "user", text },
  };
}
