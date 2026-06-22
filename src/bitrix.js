import { asRecord, normalizeText, str, stripHtml, unique } from "./utils.js";

function webhookBase(raw) {
  const value = str(raw).replace(/\/+$/, "");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const restIndex = parts.findIndex((part) => part.toLowerCase() === "rest");
  const apiOffset = parts[restIndex + 1]?.toLowerCase() === "api" ? 1 : 0;
  const requiredLength = restIndex + 3 + apiOffset;
  if (restIndex < 0 || parts.length < requiredLength) return "";

  url.pathname = `/${parts.slice(0, requiredLength).join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function methodUrl(webhookUrl, method) {
  const base = webhookBase(webhookUrl);
  if (!base) throw new Error("BITRIX_WEBHOOK_URL must look like https://host/rest/<user>/<webhook>");
  const suffix = base.includes("/rest/api/") ? method : `${method}.json`;
  return `${base}/${suffix}`;
}

function numericId(value) {
  const match = str(value).match(/\d+/);
  return match ? match[0] : "";
}

function valueByKeys(root, keys, maxDepth = 7) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set();

  function visit(value, depth) {
    if (depth > maxDepth || value == null || typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, val] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && str(val)) return val;
      const tail = key.match(/\[([^\]]+)\]$/)?.[1];
      if (tail && wanted.has(tail.toLowerCase()) && str(val)) return val;
    }
    for (const val of Object.values(value)) {
      const found = visit(val, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  return visit(root, 0);
}

export class BitrixClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async call(method, body = {}) {
    const url = methodUrl(this.config.bitrixWebhookUrl, method);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.error_description || data.error || `Bitrix HTTP ${response.status}`);
    }
    return data;
  }

  async result(method, body = {}) {
    return (await this.call(method, body)).result;
  }

  async listLeads() {
    const leads = [];
    let start = 0;
    while (leads.length < this.config.bitrixMaxLeads) {
      const page = await this.call("crm.lead.list", {
        order: { DATE_MODIFY: "ASC" },
        filter: { STATUS_ID: this.config.bitrixLeadStatusId },
        select: ["ID", "TITLE", "STATUS_ID", "SOURCE_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "DATE_MODIFY"],
        start,
      });
      const items = Array.isArray(page.result) ? page.result : [];
      leads.push(...items.map(asRecord));
      if (page.next == null || items.length === 0) break;
      const next = Number(page.next);
      if (!Number.isFinite(next) || next <= start) break;
      start = next;
    }
    return leads.slice(0, this.config.bitrixMaxLeads);
  }

  async getLead(leadId) {
    return asRecord(await this.result("crm.lead.get", { id: Number(leadId), ID: Number(leadId) }));
  }

  async updateLeadStatus(leadId, statusId) {
    if (!statusId) return { skipped: true, reason: "status_id_empty" };
    const result = await this.result("crm.lead.update", {
      id: Number(leadId),
      fields: { STATUS_ID: statusId },
      params: { REGISTER_SONET_EVENT: "N" },
    });
    return { ok: result === true, result };
  }

  async openLineChatsFromLead(leadId, activeOnly = true) {
    const result = await this.result("imopenlines.crm.chat.get", {
      CRM_ENTITY_TYPE: "lead",
      CRM_ENTITY: Number(leadId),
      ACTIVE_ONLY: activeOnly ? "Y" : "N",
    }).catch(() => []);
    if (!Array.isArray(result)) return [];
    return unique(
      result.map((item) =>
        numericId(asRecord(item).CHAT_ID ?? asRecord(item).chatId ?? asRecord(item).ID ?? asRecord(item).id),
      ),
    );
  }

  async resolveChatIds(leadId) {
    const active = await this.openLineChatsFromLead(leadId, true);
    if (active.length > 0) return active;

    const ids = [];
    try {
      ids.push(
        numericId(
          await this.result("imopenlines.crm.chat.getlastid", {
            CRM_ENTITY_TYPE: "lead",
            CRM_ENTITY: Number(leadId),
          }),
        ),
      );
    } catch {
      // fallback below
    }
    ids.push(...(await this.openLineChatsFromLead(leadId, false)));
    return unique(ids);
  }

  async getSessionHistory(chatId) {
    try {
      const result = await this.result("imopenlines.session.history.get", { CHAT_ID: Number(chatId) });
      return normalizeMessages(result);
    } catch (err) {
      await this.logger.warn("bitrix.session_history_failed", { chatId, error: err.message });
      return [];
    }
  }

  async getDialogMessages(chatId, limit = 50) {
    try {
      const result = await this.result("im.dialog.messages.get", {
        DIALOG_ID: `chat${chatId}`,
        LIMIT: limit,
      });
      return normalizeMessages(result);
    } catch (err) {
      await this.logger.warn("bitrix.dialog_messages_failed", { chatId, error: err.message });
      return [];
    }
  }

  async contextForLead(lead) {
    const leadId = str(lead.ID ?? lead.id);
    const chatIds = await this.resolveChatIds(leadId);
    const messages = [];
    for (const chatId of chatIds.slice(0, 2)) {
      messages.push(...(await this.getSessionHistory(chatId)));
      messages.push(...(await this.getDialogMessages(chatId)));
    }
    const deduped = dedupeMessages(messages);
    const lastUserMessage = [...deduped].reverse().find((item) => item.text && item.role !== "self") ?? deduped.at(-1);
    return {
      leadId,
      lead,
      chatId: chatIds[0] || "",
      chatIds,
      messages: deduped,
      lastUserMessage,
      text: lastUserMessage?.text || "",
      messageId: lastUserMessage?.id || "",
    };
  }

  async contextFromPayload(payload) {
    const leadId = leadIdFromPayload(payload);
    const payloadChatId = chatIdFromPayload(payload);
    const payloadMessageId = messageIdFromPayload(payload);
    const payloadText = textFromPayload(payload);
    if (!leadId) {
      return {
        leadId,
        chatId: payloadChatId,
        messageId: payloadMessageId,
        text: payloadText,
        from: payloadChatId || leadId,
        lead: {},
        messages: payloadText ? [{ id: payloadMessageId, role: "user", text: payloadText }] : [],
        lastUserMessage: payloadText ? { id: payloadMessageId, role: "user", text: payloadText } : undefined,
        skipReason: "missing_lead_id",
      };
    }

    const lead = await this.getLead(leadId).catch((err) => ({ __error: err.message }));
    if (lead.__error) {
      return {
        leadId,
        chatId: payloadChatId,
        messageId: payloadMessageId,
        text: payloadText,
        from: payloadChatId || leadId,
        lead: {},
        messages: payloadText ? [{ id: payloadMessageId, role: "user", text: payloadText }] : [],
        lastUserMessage: payloadText ? { id: payloadMessageId, role: "user", text: payloadText } : undefined,
        skipReason: "lead_fetch_failed",
      };
    }

    const statusId = str(lead.STATUS_ID ?? lead.statusId);
    if (this.config.bitrixLeadStatusId && statusId && statusId !== this.config.bitrixLeadStatusId) {
      return {
        leadId,
        chatId: payloadChatId,
        messageId: payloadMessageId,
        text: payloadText,
        lead,
        messages: [],
        skipReason: "lead_status_mismatch",
      };
    }

    const sourceId = str(lead.SOURCE_ID ?? lead.sourceId);
    if (sourceId && this.config.excludedSourceIds.has(sourceId)) {
      return {
        leadId,
        chatId: payloadChatId,
        messageId: payloadMessageId,
        text: payloadText,
        lead,
        messages: [],
        skipReason: "excluded_source",
      };
    }
    if (this.config.excludedLeadIds.has(leadId)) {
      return {
        leadId,
        chatId: payloadChatId,
        messageId: payloadMessageId,
        text: payloadText,
        lead,
        messages: [],
        skipReason: "excluded_lead",
      };
    }

    const chatIds = payloadChatId ? [payloadChatId] : await this.resolveChatIds(leadId);
    const messages = [];
    for (const chatId of chatIds.slice(0, 2)) {
      messages.push(...(await this.getSessionHistory(chatId)));
      messages.push(...(await this.getDialogMessages(chatId)));
    }
    const deduped = dedupeMessages(messages);
    const triggerMessage = payloadMessageId ? deduped.find((item) => str(item.id) === payloadMessageId) : undefined;
    const lastUserMessage =
      triggerMessage && triggerMessage.role !== "self"
        ? triggerMessage
        : ([...deduped].reverse().find((item) => item.text && item.role !== "self") ?? undefined);
    const text = lastUserMessage?.text || payloadText;
    return {
      leadId,
      lead,
      chatId: chatIds[0] || payloadChatId,
      chatIds,
      messages: deduped,
      lastUserMessage,
      text,
      from: chatIds[0] || payloadChatId || leadId,
      messageId: lastUserMessage?.id || payloadMessageId,
      skipReason: !text ? "missing_message_text" : triggerMessage?.role === "self" ? "not_user_message" : undefined,
    };
  }

  async sendOpenLineMessage({ leadId, chatId, userId, text }) {
    const botResult = await this.result("imopenlines.bot.session.message.send", {
      CHAT_ID: Number(chatId),
      NAME: "DEFAULT",
      MESSAGE: text,
    }).catch(() => undefined);
    if (botResult === true) {
      return {
        ok: true,
        method: "imopenlines.bot.session.message.send",
        messageId: `bot-session:${chatId}:${Date.now()}`,
      };
    }

    if (!userId) throw new Error("No assigned user id for crm.message.add fallback");
    await this.result("imopenlines.crm.chat.user.add", {
      CRM_ENTITY_TYPE: "lead",
      CRM_ENTITY: Number(leadId),
      CHAT_ID: Number(chatId),
      USER_ID: Number(userId),
    });
    const messageId = await this.result("imopenlines.crm.message.add", {
      CRM_ENTITY_TYPE: "lead",
      CRM_ENTITY: Number(leadId),
      CHAT_ID: Number(chatId),
      USER_ID: Number(userId),
      MESSAGE: text,
    });
    return { ok: true, method: "imopenlines.crm.message.add", messageId: str(messageId) };
  }
}

export function leadIdFromPayload(payload) {
  return numericId(valueByKeys(payload, ["CRM_ENTITY", "CRM_ENTITY_ID", "LEAD_ID", "lead_id", "ID"]));
}

export function textFromPayload(payload) {
  return stripHtml(valueByKeys(payload, ["MESSAGE", "MESSAGE_ORIGINAL", "text", "messageText", "body"]));
}

export function chatIdFromPayload(payload) {
  return numericId(valueByKeys(payload, ["TO_CHAT_ID", "CHAT_ID", "chat_id"]));
}

export function messageIdFromPayload(payload) {
  return str(valueByKeys(payload, ["MESSAGE_ID", "messageId", "message_id"]));
}

function normalizeMessages(raw) {
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.messages)
        ? raw.messages
        : Object.values(asRecord(raw));
  return items
    .map((item) => {
      const record = asRecord(item);
      const text = stripHtml(record.MESSAGE ?? record.message ?? record.text ?? record.TEXT ?? "");
      if (!text) return null;
      const authorId = str(
        record.AUTHOR_ID ?? record.authorId ?? record.USER_ID ?? record.userId ?? record.senderId ?? record.SENDER_ID,
      );
      const authorName = str(
        record.AUTHOR_NAME ?? record.authorName ?? record.senderName ?? record.SENDER_NAME,
      ).toLowerCase();
      const role =
        authorName.includes("bot") || authorName.includes("менеджер") || authorName.includes("support")
          ? "self"
          : "user";
      return {
        id: str(record.ID ?? record.id ?? record.MESSAGE_ID ?? record.messageId),
        authorId,
        role,
        text,
        normalized: normalizeText(text),
        createdAt: str(record.DATE_CREATE ?? record.dateCreate ?? record.DATE ?? record.date),
      };
    })
    .filter(Boolean);
}

function dedupeMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const message of messages) {
    const key = message.id || `${message.createdAt}:${message.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}
