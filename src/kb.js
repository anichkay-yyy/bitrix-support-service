import { str } from "./utils.js";

export class KbClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async search(query, opts = {}) {
    const kbIds = Array.isArray(opts.kbIds) && opts.kbIds.length > 0 ? opts.kbIds : this.config.supportKbIds;
    if (!this.config.assistantInternalUrl || kbIds.length === 0) {
      return { ok: false, error: "KB is not configured", results: [], views: [] };
    }
    const headers = { "Content-Type": "application/json" };
    if (this.config.assistantInternalToken) headers["x-internal-token"] = this.config.assistantInternalToken;
    const res = await fetch(`${this.config.assistantInternalUrl}/api/internal/kb/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kb_ids: kbIds,
        query: str(query),
        top_k: opts.topK || this.config.faqTopK,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `KB HTTP ${res.status}`, results: [], views: [] };
    return {
      ok: true,
      results: Array.isArray(data.results) ? data.results : [],
      views: Array.isArray(data.views) ? data.views : [],
    };
  }

  searchClassifier(query) {
    return this.search(query, { kbIds: this.config.classifierKbIds });
  }

  searchReply(query) {
    return this.search(query, { kbIds: this.config.replyKbIds });
  }
}

export function formatKbContext(kbResult) {
  const views = Array.isArray(kbResult.views) ? kbResult.views : [];
  const results = Array.isArray(kbResult.results) ? kbResult.results : [];

  const viewBlocks = views
    .flatMap((view) => [
      view.rules ? `### rules.md\n${String(view.rules).trim()}` : "",
      view.state ? `### state.md\n${String(view.state).trim()}` : "",
      view.tone ? `### tone.md\n${String(view.tone).trim()}` : "",
    ])
    .filter(Boolean);

  const resultBlocks = results
    .map((item) => {
      const title = item.document_title || "Документ";
      const source = item.source_ref ? `\nИсточник: ${item.source_ref}` : "";
      return `### ${title}${source}\n${String(item.content || "").trim()}`;
    })
    .filter((block) => block.trim());

  return [...viewBlocks, ...resultBlocks].join("\n\n---\n\n");
}

export function extractPreparedAnswer(kbResult) {
  const results = Array.isArray(kbResult?.results) ? kbResult.results : [];
  for (const item of results) {
    const source = str(item.source_ref);
    const content = String(item.content || "").trim();
    if (!source.startsWith("manual-faq-") && !/^FAQ exact answer:/i.test(content)) continue;
    const answer = content
      .replace(/^FAQ exact answer:\s*/i, "")
      .replace(/^([^\n]{1,120})\n+/, "")
      .trim();
    if (answer) {
      return {
        answer,
        source_ref: source,
        document_title: str(item.document_title),
      };
    }
  }
  return null;
}
