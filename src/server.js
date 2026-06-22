import { createServer } from "node:http";
import { publicConfig } from "./config.js";
import { asRecord, str } from "./utils.js";

const MAX_EVENTS = 1000;

export class StandaloneServer {
  constructor({ config, logger, state, flow }) {
    this.config = config;
    this.logger = logger;
    this.state = state;
    this.flow = flow;
    this.running = true;
    this.startedAt = Date.now();
    this.events = [];
    this.pollTimer = null;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.error("server.error", { error: err.message }).catch(() => {});
        this.json(res, 500, { ok: false, error: err.message });
      });
    });
    this.flow.setEventSink((event) => this.emit(event));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(this.config.port, this.config.host, resolve));
    await this.logger.info("service.started", {
      host: this.config.host,
      port: this.config.port,
      workflow_id: this.config.workflowId,
      instance_id: this.config.instanceId,
      dry_run: this.config.dryRun,
    });
    this.emit({ type: "trigger_waiting", channel: "bitrix24", label: "Bitrix24" });
    if (this.config.pollEnabled) this.startPolling();
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await new Promise((resolve) => this.server.close(resolve));
  }

  startPolling() {
    const run = () => {
      if (!this.running) return;
      this.flow.tick().catch((err) => {
        this.emit({ type: "poll_error", channel: "bitrix24", error: err.message });
        this.logger.error("poll.error", { error: err.message }).catch(() => {});
      });
    };
    this.pollTimer = setInterval(run, this.config.pollIntervalMs);
    setTimeout(run, 1000);
  }

  emit(event) {
    const row = { ts: Date.now(), ...event };
    this.events.push(row);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }

  async handle(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return this.empty(res, 204);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method || "GET";

    const webhookMatch = path.match(/^\/webhooks\/([^/]+)(?:\/([^/]+))?$/);
    if (method === "POST" && webhookMatch) return this.handleWebhook(req, res, decodeURIComponent(webhookMatch[1]));
    if (method === "GET" && path === "/health") return this.json(res, 200, this.health());
    if (method === "GET" && path === "/instances") return this.json(res, 200, { instances: this.instances() });
    if (method === "GET" && path === "/events") return this.json(res, 200, this.eventsSince(url));
    if (method === "GET" && path === "/state") return this.json(res, 200, this.state.snapshot());
    if (method === "POST" && path === "/run") return this.handleRun(req, res);
    if (method === "POST" && path === "/stop") return this.handleStop(req, res);
    if (method === "POST" && path === "/tick") return this.json(res, 200, await this.flow.tick());
    if (method === "POST" && path === "/analyze") return this.handleAnalyze(req, res);
    if (method === "GET" && (path === "/" || path === "/index.html")) return this.html(res);
    return this.json(res, 404, { ok: false, error: "Not found" });
  }

  async handleWebhook(req, res, workflowId) {
    if (workflowId !== this.config.workflowId) {
      return this.json(res, 404, { ok: false, error: `Workflow ${workflowId} is not served by this service` });
    }
    if (!this.running) return this.json(res, 409, { ok: false, error: `Workflow ${workflowId} is not running` });
    const payload = await this.readPayload(req);
    this.emit({ type: "webhook_received", channel: "bitrix24", workflow_id: workflowId });
    this.flow.analyzePayload(payload).catch((err) => {
      this.emit({ type: "webhook_error", channel: "bitrix24", error: err.message });
      this.logger.error("webhook.error", { error: err.message }).catch(() => {});
    });
    return this.json(res, 202, {
      ok: true,
      accepted: true,
      workflow_id: workflowId,
      channel: "bitrix24",
      instance_id: this.config.instanceId,
    });
  }

  async handleRun(req, res) {
    const body = asRecord(await this.readPayload(req));
    const workflow = asRecord(body.workflow);
    if (workflow.id && workflow.id !== this.config.workflowId) {
      return this.json(res, 400, { ok: false, error: `This service is pinned to workflow ${this.config.workflowId}` });
    }
    this.running = true;
    this.emit({ type: "trigger_waiting", channel: "bitrix24", label: "Bitrix24" });
    return this.json(res, 200, {
      ok: true,
      instance_id: this.config.instanceId,
      mode: "standalone",
      workflow_id: this.config.workflowId,
    });
  }

  async handleStop(_req, res) {
    this.running = false;
    this.emit({ type: "workflow_stop", reason: "manual_stop" });
    return this.json(res, 200, { ok: true, instance_id: this.config.instanceId, stopped_at: Date.now() });
  }

  async handleAnalyze(req, res) {
    const body = asRecord(await this.readPayload(req));
    const result = await this.flow.analyzeText({ ...body, preview_only: body.preview_only ?? true });
    return this.json(res, 200, { ok: true, result });
  }

  health() {
    return {
      ok: true,
      service: "bitrix-support-service",
      mode: "standalone",
      running_instances: this.running ? 1 : 0,
      workflow_id: this.config.workflowId,
      instance_id: this.config.instanceId,
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
      config: publicConfig(this.config),
    };
  }

  instances() {
    if (!this.running) return [];
    return [
      {
        instance_id: this.config.instanceId,
        workflow_id: this.config.workflowId,
        workflow_name: this.config.workflowName,
        pid: process.pid,
        status: "running",
        started_at: new Date(this.startedAt).toISOString(),
      },
    ];
  }

  eventsSince(url) {
    const since = Number(url.searchParams.get("since") || 0);
    const instanceId = str(url.searchParams.get("instance_id"));
    if (instanceId && instanceId !== this.config.instanceId) return { events: [], latest_ts: since };
    const events = Number.isFinite(since) && since > 0 ? this.events.filter((event) => event.ts > since) : this.events;
    return { events, latest_ts: events.at(-1)?.ts ?? since };
  }

  async readPayload(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const contentType = String(req.headers["content-type"] || "");
    if (!raw.trim()) return {};
    if (contentType.includes("application/json")) return JSON.parse(raw);
    if (contentType.includes("application/x-www-form-urlencoded") || raw.includes("=")) {
      const form = new URLSearchParams(raw);
      const out = {};
      for (const [key, value] of form.entries()) out[key] = value;
      return out;
    }
    return { raw_body: raw };
  }

  json(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value, null, 2));
  }

  empty(res, status) {
    res.writeHead(status);
    res.end();
  }

  html(res) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Bitrix Support Service</title><pre>${JSON.stringify(this.health(), null, 2)}</pre>`);
  }
}
