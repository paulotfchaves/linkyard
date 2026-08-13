-- 004_analytics.sql — click events, their daily rollup, the audit trail, and
-- infrastructure usage samples.

-- Partitioned from day one. Converting a multi-million-row table to partitioned
-- later means downtime, and this is the only table with unbounded growth.
CREATE TABLE click_events (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  link_id       uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- HMAC of the client address, never the address itself. A raw IP is personal
  -- data under the LGPD and the product has no use for one.
  ip_hash       bytea,
  country       text,
  region        text,
  city          text,
  asn           integer,
  device        text,
  os            text,
  browser       text,
  language      text,
  referrer_host text,
  referrer_full text,
  -- WhatsApp, Meta, Telegram, Slack and Discord all fetch a link to build a
  -- preview. Counting those as clicks is the most common way a link report
  -- becomes useless, so bots are recorded and excluded — never dropped.
  is_bot        boolean NOT NULL DEFAULT false,
  bot_kind      text,
  final_url     text,
  latency_ms    integer,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX click_events_link_time_idx ON click_events (link_id, occurred_at DESC);
CREATE INDEX click_events_human_idx ON click_events (occurred_at) WHERE NOT is_bot;

-- Catch-all so an insert can never fail for want of a partition. A lost click
-- is worse than a slightly untidy table.
CREATE TABLE click_events_default PARTITION OF click_events DEFAULT;

CREATE FUNCTION ensure_click_partition(month date) RETURNS text AS $$
DECLARE
  start_date  date := date_trunc('month', month)::date;
  end_date    date := (date_trunc('month', month) + interval '1 month')::date;
  part_name   text := 'click_events_' || to_char(start_date, 'YYYY_MM');
  schema_name text := current_schema();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = part_name AND n.nspname = schema_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF click_events FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );
  END IF;
  RETURN part_name;
END;
$$ LANGUAGE plpgsql;

-- The panel reads from here, never from click_events, so a dashboard stays fast
-- at millions of rows. Rollups survive the purge of the raw events.
CREATE TABLE click_daily (
  link_id     uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day         date NOT NULL,
  clicks      integer NOT NULL DEFAULT 0,
  uniques     integer NOT NULL DEFAULT 0,
  bot_clicks  integer NOT NULL DEFAULT 0,
  by_country  jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_device   jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_referrer jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, day)
);

CREATE INDEX click_daily_day_idx ON click_daily (day DESC);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip_hash     bytea,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_time_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE usage_samples (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sampled_at     timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL CHECK (source IN ('railway', 'local')),
  cpu_vcpu       numeric(10, 4),
  memory_gb      numeric(10, 4),
  egress_gb      numeric(12, 6),
  disk_gb        numeric(10, 4),
  estimated_cost numeric(10, 2),
  period_start   timestamptz,
  period_end     timestamptz
);

CREATE INDEX usage_samples_time_idx ON usage_samples (sampled_at DESC);
