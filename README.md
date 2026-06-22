# bitrix-support-service

Standalone Bitrix support bot service. It does not import or start `workflow-runtime`.

## Flow

```text
Bitrix webhook or poll
-> Bitrix ingest/context checks
-> need_reply_gate
-> simple_reply_gate
-> existing order/order-status handler
-> deterministic templates
-> answer validation
-> Bitrix Open Lines send + lead status update
```

## Runtime API

The service intentionally exposes the runtime-compatible endpoints used by the sandbox monitor:

- `GET /health`
- `GET /instances`
- `GET /events?instance_id=...&since=...`
- `POST /run`
- `POST /stop`
- `POST /webhooks/:workflow_id/:channel?`

Additional standalone endpoints:

- `POST /tick` poll matching Bitrix leads once
- `POST /analyze` analyze supplied text in preview mode
- `GET /state` inspect local idempotency/decision state

For `sandbox.mary.maryrose.by/sandbox` compatibility, run it on the `mary-20_default` Docker network with alias `workflow-runtime` and port `3900`.

## Run

```bash
cp .env.example .env
npm start
```

Docker:

```bash
docker compose -f docker-compose.example.yml up -d --build
```

`DRY_RUN=true` by default. Set `DRY_RUN=false` only when ready to send replies and update Bitrix lead statuses.

## Mary services deploy

This repository is packaged to be imported by Mary Services as a standalone service, the same way as `erp-proxy-service`.

Import payload:

```text
slug: bitrix-support
name: bitrix-support
repo_url: https://github.com/anichkay-yyy/bitrix-support-service.git
ref: main
dockerfile: Dockerfile
env_file_path: .env.sops
```

`env_file_path` is optional for a dry-run health deployment. Use `.env.sops` for a real Bitrix deployment and pass the matching age private key to Mary as `env_decrypt_key`.

The service health endpoint is `GET /health`. Bitrix webhooks should target:

```text
/webhooks/<WORKFLOW_ID>/bitrix24
```

The container exposes port `3900` and writes local idempotency state to `/data/state.json`.

## Knowledge base

This service is a Bitrix channel adapter. It does not own or query Mary knowledge bases; KB selection and agent reasoning belong to the Mary platform.
