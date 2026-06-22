import { normalizeText, str } from "./utils.js";
import { extractOrderNumbers, looksLikeOrderQuestion, renderOrderAnswer } from "./order-status.js";
import {
  EXTRA_COPY_TEMPLATE,
  REPRINT_TEMPLATE,
  looksLikeExtraCopyRequest,
  looksLikeReprintRequest,
} from "./templates.js";

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
