-- 003_links.sql — the links themselves, their history, and scheduled swaps.

CREATE TABLE links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subdomain_id  uuid NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  target_url    text NOT NULL,
  -- 302, not 301. A 301 is cached by the browser forever, which silently breaks
  -- the core promise of this product: change the destination, keep the URL.
  redirect_type smallint NOT NULL DEFAULT 302
                  CHECK (redirect_type IN (301, 302, 307, 308)),
  utm_id        text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  pass_through  boolean NOT NULL DEFAULT false,
  is_pinned     boolean NOT NULL DEFAULT false,
  expires_at    timestamptz,
  fallback_url  text,
  tag_id        uuid REFERENCES tags(id) ON DELETE SET NULL,
  note          text,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_slug_format CHECK (slug ~ '^[A-Za-z0-9._~-]{1,120}$'),
  -- These paths are served by the edge itself. A link on one of them would be
  -- unreachable, and losing the robots/favicon responses is part of what makes
  -- a redirect domain look disposable to malware scanners.
  CONSTRAINT links_slug_not_reserved CHECK (
    lower(slug) NOT IN ('health', 'robots.txt', 'favicon.ico', 'sitemap.xml', '_status', '_linkyard')
    AND lower(slug) NOT LIKE '.well-known%'
  )
);

CREATE UNIQUE INDEX links_subdomain_slug_key ON links (subdomain_id, lower(slug));
CREATE INDEX links_tag_idx ON links (tag_id);
CREATE INDEX links_active_idx ON links (active) WHERE active;
CREATE INDEX links_pinned_idx ON links (is_pinned) WHERE is_pinned;
CREATE INDEX links_expires_idx ON links (expires_at) WHERE expires_at IS NOT NULL;

CREATE TRIGGER links_updated_at
  BEFORE UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ON DELETE SET NULL, not CASCADE: the record of a destination change must
-- outlive the link it describes.
CREATE TABLE link_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    uuid REFERENCES links(id) ON DELETE SET NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  source     text NOT NULL CHECK (source IN ('panel', 'schedule', 'import', 'api')),
  before     jsonb NOT NULL,
  after      jsonb NOT NULL
);

CREATE INDEX link_versions_link_idx ON link_versions (link_id, changed_at DESC);

-- fire_at is UTC. author_timezone records the IANA zone the human was thinking
-- in, so the panel can render "14:00 America/Sao_Paulo" back to them instead of
-- an unexplained UTC instant.
CREATE TABLE schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_ids        uuid[] NOT NULL,
  fire_at         timestamptz NOT NULL,
  author_timezone text NOT NULL,
  patch           jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  executed_at     timestamptz,
  previous        jsonb,
  note            text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_patch_not_empty CHECK (patch <> '{}'::jsonb),
  CONSTRAINT schedules_has_targets CHECK (coalesce(array_length(link_ids, 1), 0) >= 1)
);

CREATE INDEX schedules_due_idx ON schedules (fire_at) WHERE status = 'pending';
