import { asRecord, normalizeText, str } from "./utils.js";
import { extractOrderNumbers, looksLikeOrderQuestion, renderOrderAnswer } from "./order-status.js";
import {
  EXTRA_COPY_TEMPLATE,
  REPRINT_TEMPLATE,
  looksLikeExtraCopyRequest,
  looksLikeReprintRequest,
} from "./templates.js";
import { extractPreparedAnswer, formatKbContext } from "./kb.js";

const STOP_TOPIC_IDS = new Set(["T09", "T18", "T19", "T21", "T27", "T28"]);

export function needReplyGate(text) {
  const raw = normalizeText(text).toLowerCase();
  if (!raw) return decision("skip", "empty_text", "", { handler: "need_reply_gate" });
  if (/^(?:ок|окей|понял[аи]?|ясно|хорошо|спасибо|благодарю)[!. ]*$/iu.test(raw)) return null;
  if (
    /^(?:файл|фото|скрин|чек|оплату|макет).{0,40}(?:отправил|отправила|прикрепил|прикрепила|скинул|скинула|направил|направила)$/iu.test(
      raw,
    )
  ) {
    return decision("skip", "receipt_acknowledgement_only", "", { handler: "need_reply_gate" });
  }
  return null;
}

export function simpleReply(text) {
  const raw = normalizeText(text).toLowerCase();
  if (/^(привет|здравствуйте|добрый день|добрый вечер|доброе утро)[!. ]*$/iu.test(raw)) {
    return decision("reply", "simple_greeting", "Здравствуйте! Подскажите, пожалуйста, чем можем помочь?", {
      handler: "simple_reply_gate",
    });
  }
  if (/^(спасибо|спасибо большое|благодарю|понял[аи]?|хорошо|ок|окей)[!. ]*$/iu.test(raw)) {
    return decision("reply", "simple_ack", "Рады были помочь. Если возникнут вопросы, пишите.", {
      handler: "simple_reply_gate",
    });
  }
  return null;
}

export async function orderStatusHandler({ text, orderStatusClient }) {
  if (!looksLikeOrderQuestion(text)) return null;
  const numbers = extractOrderNumbers(text).slice(0, 3);
  const lookup = await orderStatusClient.lookup(numbers);
  if (!lookup.ok)
    return decision("skip", "order_lookup_error", "", { error: lookup.error, handler: "order_info_agent" });
  const answer = renderOrderAnswer(lookup.result, numbers);
  if (!answer)
    return decision("skip", "order_not_replyable", "", { handler: "order_info_agent", order_result: lookup.result });
  return decision("reply", "order_status", answer, {
    handler: "order_info_agent",
    nextStatusId: "UC_58B8VD",
    nextStatusTitle: "Завершен",
    order_result: lookup.result,
  });
}

export function templateHandler(text) {
  if (looksLikeReprintRequest(text)) {
    return decision("reply", "reprint_template", REPRINT_TEMPLATE, {
      handler: "order_info_agent",
      nextStatusId: "UC_58B8VD",
    });
  }
  if (looksLikeExtraCopyRequest(text)) {
    return decision("reply", "extra_copy_template", EXTRA_COPY_TEMPLATE, {
      handler: "order_info_agent",
      nextStatusId: "UC_58B8VD",
    });
  }
  return null;
}

export async function classifySupportQuestion({ text, contextMessages, kbClient, llmClient }) {
  const kbResult = await kbClient.searchClassifier(text);
  if (!kbResult.ok || kbResult.results.length === 0) {
    return decision("skip", "classifier_no_kb_match", "", { handler: "topic_classifier", kb_error: kbResult.error });
  }

  const kbContext = formatKbContext(kbResult);
  const prepared = extractPreparedAnswer(kbResult);
  const system = [
    "Ты классификатор поддержки Фабрики Фотокниги для Bitrix Open Lines.",
    "Определи ровно одну тему T01-T31, stop/safe признаки и наличие прямого готового ответа из KB.",
    "Не отвечай клиенту. Верни только JSON.",
    "Always-stop: юридические угрозы, брак/дефект, негатив/жалоба/угрозы, скидки/промокоды/акции/пробный заказ, ошибка клиента/перепечатка, повреждение упаковки.",
    "Stop topic_id: T09, T18, T19, T21, T27, T28.",
    "Delivery conditional: T02/T16/T24/T25/T26 можно пропускать только для общего вопроса без проверки конкретного заказа и при прямом KB exact answer.",
    "Current order status/tracking/ETA по конкретному заказу не классифицируй как обычный FAQ, это должен был обработать order flow.",
    'JSON schema: {"stage":"classification","topic_id":"T##","topic_title":"...","topic_confidence":0.0,"kb_exact_answer_match":false,"matched_kb_source_ref":null,"requires_external_lookup":false,"is_current_order_status":false,"business_decision_required":false,"stop_topic":false,"stop_reasons":[],"delivery":false,"discount_or_promo":false,"reprint_or_customer_error":false,"defective_product":false,"negative":false,"legal_terms":false,"evidence":["..."]}',
  ].join("\n");
  const user = [
    "# Сообщение клиента",
    text,
    "",
    "# Контекст диалога",
    contextMessages
      .slice(-8)
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n"),
    "",
    prepared
      ? `# Найденный готовый ответ\nИсточник: ${prepared.source_ref}\n${prepared.answer}`
      : "# Найденный готовый ответ\nНет прямого manual FAQ exact answer.",
    "",
    "# KB classifier context",
    kbContext,
  ].join("\n");

  const llm = await llmClient.completeJson({ system, user, maxTokens: 1800, temperature: 0 });
  if (!llm.ok) return decision("skip", "classifier_llm_error", "", { handler: "topic_classifier", error: llm.error });
  const classification = normalizeClassification(asRecord(llm.result), prepared);
  return {
    action: "continue",
    reason: "classified",
    handler: "topic_classifier",
    classification,
    classifier_kb: kbResult.results
      .map((hit) => ({ title: hit.document_title, source: hit.source_ref, score: hit.rrf_score }))
      .slice(0, 8),
    prepared_answer: prepared,
  };
}

export function safeTopicGate(classified) {
  const c = asRecord(classified?.classification ?? classified);
  const topicId = str(c.topic_id).toUpperCase();
  const reasons = Array.isArray(c.stop_reasons) ? c.stop_reasons.map(str).filter(Boolean) : [];
  const stop =
    c.stop_topic === true ||
    STOP_TOPIC_IDS.has(topicId) ||
    c.legal_terms === true ||
    c.defective_product === true ||
    c.negative === true ||
    c.discount_or_promo === true ||
    c.reprint_or_customer_error === true ||
    c.requires_external_lookup === true ||
    c.business_decision_required === true ||
    (c.delivery === true && c.kb_exact_answer_match !== true);
  if (stop) {
    return decision("skip", reasons[0] || "stop_topic", "", { handler: "safe_topic_gate", classification: c });
  }
  return null;
}

export async function generateSupportReply({ text, contextMessages, classified, kbClient, llmClient }) {
  const classification = asRecord(classified.classification);
  const prepared = classified.prepared_answer;
  const kbResult = await kbClient.searchReply(text);
  if (!kbResult.ok || kbResult.results.length === 0) {
    return decision("skip", "reply_no_kb_match", "", {
      handler: "reply_generator",
      classification,
      kb_error: kbResult.error,
    });
  }

  const kbContext = formatKbContext(kbResult);
  const system = [
    "Ты support reply generator для Фабрики Фотокниги в Bitrix Open Lines.",
    "Пиши только если вопрос безопасный и ответ полностью grounded in KB/classification/prepared_answer.",
    "Если нет прямого ответа, верни decision=skip.",
    "Если есть prepared_answer, используй его как основной текст; можно только слегка адаптировать под короткий messenger style, не менять смысл.",
    "Не обещай проверить, уточнить, передать менеджеру, позвонить или посмотреть во внутренних системах.",
    "Не упоминай JSON, workflow, KB, source_ref, topic_id, confidence.",
    "Ответ по-русски, вежливо, лаконично, без эмодзи.",
    "Выбери next_status_id: UC_58B8VD для завершенного ответа, UC_GL5G4V если клиент должен прислать данные.",
    'Верни только JSON: {"stage":"support_reply","confidence":0.0,"decision":"send|skip","skip_reason":null,"policy_answer_from_kb":false,"next_status_id":"UC_58B8VD","next_status_title":"Завершен","next_status_reason":"...","answer":"...","checks":["kb_grounded","messenger_style"]}',
  ].join("\n");
  const user = [
    "# Сообщение клиента",
    text,
    "",
    "# Контекст диалога",
    contextMessages
      .slice(-8)
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n"),
    "",
    "# Classification JSON",
    JSON.stringify(classification, null, 2),
    "",
    prepared ? `# prepared_answer\nИсточник: ${prepared.source_ref}\n${prepared.answer}` : "# prepared_answer\nНет.",
    "",
    "# Compact reply KB context",
    kbContext,
  ].join("\n");

  const llm = await llmClient.completeJson({ system, user, maxTokens: 2200, temperature: 0.2 });
  if (!llm.ok)
    return decision("skip", "reply_llm_error", "", { handler: "reply_generator", error: llm.error, classification });

  const result = asRecord(llm.result);
  const confidence = Number(result.confidence || 0);
  const answer = str(result.answer);
  if (result.decision !== "send" || confidence < 0.7 || !answer) {
    return decision("skip", str(result.skip_reason) || "reply_low_confidence", "", {
      handler: "reply_generator",
      confidence,
      classification,
      reply_kb: kbResult.results.map((hit) => hit.document_title).slice(0, 5),
    });
  }

  return decision("reply", "support_kb_answer", answer, {
    handler: "reply_generator",
    confidence,
    classification,
    nextStatusId: str(result.next_status_id) || "UC_58B8VD",
    nextStatusTitle: str(result.next_status_title) || "Завершен",
    nextStatusReason: str(result.next_status_reason) || "complete_kb_answer",
    reply_kb: kbResult.results
      .map((hit) => ({ title: hit.document_title, source: hit.source_ref, score: hit.rrf_score }))
      .slice(0, 8),
  });
}

export async function faqHandler({ text, contextMessages, kbClient, llmClient }) {
  const classified = await classifySupportQuestion({ text, contextMessages, kbClient, llmClient });
  if (classified.action !== "continue") return classified;
  const stopped = safeTopicGate(classified);
  if (stopped) return stopped;
  return generateSupportReply({ text, contextMessages, classified, kbClient, llmClient });
}

export function validateAnswer(result) {
  if (!result || result.action !== "reply") return result;
  const answer = str(result.answer);
  if (!answer) return { ...result, action: "skip", reason: "empty_answer" };
  if (answer.length > 5000) return { ...result, action: "skip", reason: "answer_too_long" };
  if (/\b(?:workflow|json|confidence|source_ref|tool_called|skip_reason|topic_id)\b/iu.test(answer)) {
    return { ...result, action: "skip", reason: "internal_terms_in_answer" };
  }
  if (/уточн[юи] у менеджер|передам менеджер|с вами свяжется менеджер/iu.test(answer)) {
    return { ...result, action: "skip", reason: "forbidden_manager_promise" };
  }
  return result;
}

function normalizeClassification(raw, prepared) {
  const topicId = str(raw.topic_id).toUpperCase();
  const stopReasons = Array.isArray(raw.stop_reasons) ? raw.stop_reasons.map(str).filter(Boolean) : [];
  const exact = raw.kb_exact_answer_match === true || Boolean(prepared);
  const stopByTopic = STOP_TOPIC_IDS.has(topicId);
  return {
    stage: "classification",
    topic_id: topicId || "T00",
    topic_title: str(raw.topic_title),
    topic_confidence: Number(raw.topic_confidence || 0),
    kb_exact_answer_match: exact,
    matched_kb_source_ref: str(raw.matched_kb_source_ref) || prepared?.source_ref || null,
    requires_external_lookup: raw.requires_external_lookup === true,
    is_current_order_status: raw.is_current_order_status === true,
    business_decision_required: raw.business_decision_required === true,
    stop_topic: raw.stop_topic === true || stopByTopic,
    stop_reasons: stopByTopic && stopReasons.length === 0 ? ["stop_topic"] : stopReasons,
    delivery: raw.delivery === true,
    discount_or_promo: raw.discount_or_promo === true,
    reprint_or_customer_error: raw.reprint_or_customer_error === true,
    defective_product: raw.defective_product === true,
    negative: raw.negative === true,
    legal_terms: raw.legal_terms === true,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(str).filter(Boolean).slice(0, 5) : [],
  };
}

function decision(action, reason, answer = "", extra = {}) {
  return {
    action,
    reason,
    answer,
    nextStatusId: action === "reply" ? "UC_58B8VD" : "",
    nextStatusTitle: action === "reply" ? "Завершен" : "",
    ...extra,
  };
}
