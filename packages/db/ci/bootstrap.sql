-- CI / local bootstrap before applying Drizzle-generated migrations.
-- Drizzle migrations reference the `growthos` schema and use gen_random_uuid().

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS growthos;
