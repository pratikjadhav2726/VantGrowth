-- ClickHouse bootstrap for GrowthOS dev environment.
-- Runs once on container first-start via /docker-entrypoint-initdb.d/.
-- All tables live in the `growthos` database (set by CLICKHOUSE_DB env var).

-- activity_log: high-volume per-tenant event stream (time-series, immutable).
CREATE TABLE IF NOT EXISTS growthos.activity_log
(
    tenant_id       UUID         NOT NULL,
    event_id        UUID         NOT NULL DEFAULT generateUUIDv4(),
    event_type      LowCardinality(String) NOT NULL,
    occurred_at     DateTime64(3, 'UTC')   NOT NULL,
    agent_id        Nullable(String),
    issue_id        Nullable(UUID),
    workflow_run_id Nullable(UUID),
    payload         JSON,
    _ingested_at    DateTime64(3, 'UTC')   DEFAULT now64()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, occurred_at, event_id)
TTL occurred_at + INTERVAL 18 MONTH;

-- cost_events: LLM + API cost tracking per tenant.
CREATE TABLE IF NOT EXISTS growthos.cost_events
(
    tenant_id       UUID         NOT NULL,
    event_id        UUID         NOT NULL DEFAULT generateUUIDv4(),
    recorded_at     DateTime64(3, 'UTC')   NOT NULL,
    provider        LowCardinality(String) NOT NULL,  -- 'anthropic','openai','perplexity',...
    model           LowCardinality(String) NOT NULL,
    agent_id        Nullable(String),
    issue_id        Nullable(UUID),
    input_tokens    UInt32       NOT NULL DEFAULT 0,
    output_tokens   UInt32       NOT NULL DEFAULT 0,
    cost_usd        Decimal(14, 8) NOT NULL DEFAULT 0,
    _ingested_at    DateTime64(3, 'UTC')   DEFAULT now64()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(recorded_at)
ORDER BY (tenant_id, recorded_at, event_id)
TTL recorded_at + INTERVAL 18 MONTH;

-- llm_call_logs: per-call LLM observability — tokens, latency, cost, cache status.
-- Written by LlmCallLogSink (batched HTTP inserts); never mutated after insert.
CREATE TABLE IF NOT EXISTS growthos.llm_call_logs
(
    tenant_id       UUID                           NOT NULL,
    call_id         UUID                           NOT NULL DEFAULT generateUUIDv4(),
    prompt_id       LowCardinality(String)         NOT NULL,
    prompt_version  LowCardinality(String)         NOT NULL,
    model           LowCardinality(String)         NOT NULL,
    input_tokens    UInt32                         NOT NULL DEFAULT 0,
    output_tokens   UInt32                         NOT NULL DEFAULT 0,
    latency_ms      UInt32                         NOT NULL DEFAULT 0,
    cost_usd        Decimal(14, 8)                 NOT NULL DEFAULT 0,
    cached          Bool                           NOT NULL DEFAULT false,
    agent_id        Nullable(String),
    issue_id        Nullable(UUID),
    called_at       DateTime64(3, 'UTC')           NOT NULL,
    _ingested_at    DateTime64(3, 'UTC')           DEFAULT now64()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(called_at)
ORDER BY (tenant_id, called_at, call_id)
TTL called_at + INTERVAL 24 MONTH;

-- signal_attribution: raw attribution touchpoints per tenant.
CREATE TABLE IF NOT EXISTS growthos.signal_attribution
(
    tenant_id       UUID         NOT NULL,
    touchpoint_id   UUID         NOT NULL DEFAULT generateUUIDv4(),
    contact_id      Nullable(UUID),
    channel         LowCardinality(String) NOT NULL,
    motion_type     LowCardinality(String) NOT NULL,
    attributed_at   DateTime64(3, 'UTC')   NOT NULL,
    weight          Float32      NOT NULL DEFAULT 1.0,
    payload         JSON,
    _ingested_at    DateTime64(3, 'UTC')   DEFAULT now64()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(attributed_at)
ORDER BY (tenant_id, attributed_at, touchpoint_id)
TTL attributed_at + INTERVAL 18 MONTH;
