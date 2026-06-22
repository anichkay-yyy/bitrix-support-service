import { createHash } from "node:crypto";

export function str(value) {
  return String(value ?? "").trim();
}

export function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

export function int(value, fallback, min = undefined, max = undefined) {
  const parsed = Number(value);
  let result = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  if (min != null) result = Math.max(min, result);
  if (max != null) result = Math.min(max, result);
  return result;
}

export function splitCsv(value) {
  return str(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function redact(value) {
  return String(value ?? "")
    .replace(/(rest\/\d+\/)[^/\s]+/gi, "$1[redacted]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(BITRIX_WEBHOOK_URL)=\S+/gi, "$1=[redacted]");
}

export function hashText(value) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, 16);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripHtml(value) {
  return str(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeText(value) {
  return stripHtml(value).replace(/\s+/g, " ").trim();
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function truncate(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
