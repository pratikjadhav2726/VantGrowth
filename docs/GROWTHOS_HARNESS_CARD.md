# GrowthOS GTM Harness Card

- Owner: GrowthOS platform
- Generated: 2026-07-09T00:00:00.000Z
- Model policy: OpenAI-compatible runner behind `LlmCallRunner`; default model is configurable per call and per runner.
- Prompt priority: system > tool > developer > repo > user > history

## Component Coverage

| Layer | Component | Status | Version | Evidence | Gap |
|---|---|---|---|---|---|
| control | Approval queue and feedback gate | yes | 1.0.0 | `apps/api/src/routes/approvals.ts` | Add risk-tier-specific policy gates before dispatch. |
| control | Prompt priority policy | partial | 1.0.0 | `packages/llm-harness/src/prompt-priority.ts` | Wire policy into every agent adapter and prompt assembler. |
| control | Loop governors | partial | 1.0.0 | `packages/core/src/workflow-state.ts` | Add max-step/retry governors to heartbeat runs. |
| agency | Versioned prompt contracts | yes | 1.0.0 | `packages/llm-harness/src/prompt-template.ts` | Move all prompt-only JSON instructions to native structured output. |
| agency | Native structured output | partial | 1.0.0 | `packages/llm-harness/src/llm-call-runner.ts` | Adopt `responseFormat` in all structured-output workers. |
| agency | Skill/playbook library | partial | 0.1.0 | `packages/skills/library` | Add resolver-backed JIT skill loading and eval-backed golden examples. |
| runtime | Durable event outbox | yes | 1.0.0 | `packages/db/src/postgres-outbox-repository.ts` | Add end-to-end gap replay tests through NATS consumers. |
| runtime | Workflow state machine | yes | 1.0.0 | `packages/core/src/workflow-state.ts` | Add durable step memoization for LLM/tool calls. |
| runtime | Tenant isolation | yes | 1.0.0 | `packages/db/src/rls-invariants.test.ts` | Extend generated invariants to every new tenant table automatically. |
| runtime | GenAI observability | partial | 1.0.0 | `packages/llm-harness/src/openai-runner.ts` | Add full trace correlation across API, worker, n8n, and Paperclip runs. |
| verification | Golden eval runner | partial | 1.0.0 | `packages/llm-harness/src/evals.ts` | Build real GTM golden sets from approval/rejection history. |
| verification | Critique worker | partial | 1.0.0 | `apps/worker-critique/src/critique-worker.ts` | Calibrate judge-vs-human agreement and store trend metrics. |
| verification | Harness ablations | partial | 1.0.0 | `packages/llm-harness/src/evals.ts` | Run baseline/candidate evals in CI or nightly jobs. |

## Current Score Estimate

- SaaS runtime harness: 7.0/10
- Mature agent harness: 6.8/10
- Target after next implementation tranche: 8.0/10

## Next Gap Closures

1. Adopt `responseFormat: { type: "json_schema", ... }` in `ContentStrategistWorker`, `IntelDirectorWorker`, signal grading, and critique scoring.
2. Add a checked-in `evals/golden/` fixture set generated from real approval feedback, with pass@1 and pass^k summaries.
3. Wire the HarnessCard generator into a script that emits this card after nightly evals.
4. Add sandbox/egress policy enforcement before any unattended tool execution or external dispatch.
5. Add trace IDs and run IDs to every outbox, NATS, n8n, and LLM span boundary.
