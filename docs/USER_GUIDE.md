# GrowthOS User Guide

This guide is for founders/operators using GrowthOS locally or in a shared dev environment.

## 1) Start the app

Recommended (Docker):

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build -d
```

Open:

- Web: `http://localhost:3080`
- API health: `http://localhost:3091/health`

## 2) Login

- Go to `/login`
- Email: any valid email
- Password:
  - `GROWTHOS_WEB_ADMIN_PASSWORD` if set
  - otherwise default `growthos-dev-admin`

## 3) Complete onboarding

Go to `/onboarding` and complete:

1. Company details
2. Brand context
3. Motion stack reveal
4. Finish

All required fields now validate inline before submit.

## 4) Daily workflow

### Approvals

- Visit `/approvals`
- Review generated outputs
- Approve/reject and leave notes

### Motion stack

- Visit `/motion`
- Re-score your GTM motion profile
- Review score trend and stack recommendations

### Signals

- Visit `/signals`
- Ingest market/product/customer signals
- Use grade preview when LLM is configured

### Weekly review

- Visit `/weekly-review`
- Track approval flow, output velocity, and founder checklist

## 5) Key configuration

From `.env`:

- `GROWTHOS_API_SERVICE_TOKEN` for protected API mutations
- `OPENAI_API_KEY` to enable LLM-backed grading/generation
- `PAPERCLIP_BASE_URL` + `PAPERCLIP_SERVICE_TOKEN` for Paperclip integration
- `GROWTHOS_REQUIRE_PAPERCLIP=true` for strict Paperclip connectivity mode

## 6) Troubleshooting

- If API is unhealthy, check:
  - `docker compose -f compose.dev.yaml ps`
  - `docker compose -f compose.dev.yaml logs api`
- If strict Paperclip mode is enabled and disconnected:
  - `/health` returns `ok: false`
  - web layout shows a warning banner
- If onboarding or approvals fail, verify API token and tenant headers.

## 7) Operational runbooks

For infra incidents, see:

- `docs/runbooks/nats-leader-loss.md`
- `docs/runbooks/postgres-failover.md`
- `docs/runbooks/openbao-seal-unseal.md`
- `docs/runbooks/adaptive-gtm-local-runtime.md`
