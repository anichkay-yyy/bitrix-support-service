import { asRecord, str } from "./utils.js";

export function extractOrderNumbers(value) {
  const matches =
    String(value ?? "").match(/\b\d{5,24}(?:[-_][A-Za-zА-Яа-я0-9]{1,16}|[A-Za-zА-Яа-я]{2,16})?\b/gu) || [];
  const seen = new Set();
  const result = [];
  for (const match of matches) {
    const key = match
      .replace(/[-_].*$/, "")
      .replace(/[A-Za-zА-Яа-я].*$/u, "")
      .replace(/\D/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(match);
  }
  return result;
}

export function looksLikeOrderQuestion(text) {
  const raw = String(text ?? "").toLowerCase();
  return (
    extractOrderNumbers(raw).length > 0 &&
    /(?:заказ|трек|достав|отгруз|сдэк|тк|транспорт|посыл|где|отправ|получ|ожида|статус)/iu.test(raw)
  );
}

export class OrderStatusClient {
  constructor(config) {
    this.config = config;
  }

  async lookup(numbers) {
    if (!this.config.orderStatusServiceUrl) return { ok: false, error: "ORDER_STATUS_SERVICE_URL is not configured" };
    const trackNumber = Array.isArray(numbers) ? numbers.slice(0, 3).join(" ") : str(numbers);
    const url = new URL(`${this.config.orderStatusServiceUrl}/getOrderIdByNumber`);
    url.searchParams.set("trackNumber", trackNumber);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(35_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 || data.found === false)
      return { ok: true, result: { type: "not_found", should_reply: false } };
    if (!res.ok) return { ok: false, error: str(data.error) || `HTTP ${res.status}` };
    return { ok: true, result: data };
  }
}

export function renderOrderAnswer(result, fallbackNumbers = []) {
  const payload = asRecord(result);
  if (payload.type === "multi" && Array.isArray(payload.orders)) {
    const replies = payload.orders.map((item, index) => renderSingleOrderAnswer(item, fallbackNumbers[index] || ""));
    if (replies.some((reply) => !reply)) return "";
    return replies.join("\n\n");
  }
  return renderSingleOrderAnswer(payload, fallbackNumbers[0] || "");
}

function renderSingleOrderAnswer(result, fallbackNumber) {
  const item = asRecord(result);
  const type = str(item.type);
  if (item.should_reply === false || type === "not_found") return "";

  const number = str(item.order_number || item.order_id || item.track_number || fallbackNumber);
  if (type === "received") return `Ваш заказ ${number} уже вручен получателю.`;

  if (type === "transport_status") {
    const stage = str(item.transport_stage || item.current_delivery_status || item.order_status);
    const planned = str(item.planned_delivery_date);
    return [
      `Заказ ${number} уже передан в службу доставки и отслеживается на сайте транспортной компании.`,
      stage ? `Текущий этап: ${stage}.` : "",
      planned ? `Плановая дата доставки: ${planned}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (type === "shipped") {
    const date = str(item.date);
    return `Ваш заказ покинул производство для дальнейшей доставки${date ? ` ${date}` : ""}. Обратите внимание, что отправления начинают отслеживаться не сразу после передачи в транспортную компанию: требуется 24-48 часов на транспортировку в центральный сортировочный центр службы доставки и сканирование в системе. После сканирования статус обновится на сайте транспортной компании, и Вы сможете отслеживать движение посылки.`;
  }

  if (type === "tomorrow") {
    return "Заказ ожидает отгрузку. Если он готов, но не попал в отсечку, он будет передан в транспортную компанию на следующий день. После передачи заказа в транспортную компанию требуется 24-48 часов на транспортировку в центральный сортировочный центр и сканирование в системе, после чего Вы сможете отследить его движение на сайте транспортной компании.";
  }

  if (type === "unpaid") return `Заказ ${number} найден, но оплата пока не поступила.`;
  if (type === "new") return `Заказ ${number} найден, но ещё не передан в производство.`;
  if (type === "in_work") return `Заказ ${number} найден, но ещё не передан в доставку.`;
  return "";
}
