import { str } from "./utils.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class LlmClient {
  constructor(config) {
    this.config = config;
  }

  async completeJson({ system, user, maxTokens = 1600, temperature = 0.2 }) {
    if (!this.config.openrouterApiKey) return { ok: false, error: "OPENROUTER_API_KEY is not configured" };
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.openrouterModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error?.message || data.error || `LLM HTTP ${res.status}` };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") return { ok: false, error: "LLM output truncated" };
    const text = str(choice?.message?.content);
    const parsed = parseJsonObject(text);
    if (!parsed) return { ok: false, error: "LLM returned non-JSON", raw: text };
    return { ok: true, result: parsed, raw: text };
  }
}

function parseJsonObject(value) {
  const text = str(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
