-- 002_infrastructure.sql — provider credentials and the domains they manage.

-- Credentials are sealed by core/vault.mjs before they arrive here. There is
-- deliberately no plaintext column: a database dump must not reveal a token.
-- last4 exists so the UI can identify a credential without decrypting it.
CREATE TABLE credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('cloudflare', 'railway', 'maxmind', 'safebrowsing')),
  label       text NOT NULL,
  ciphertext  bytea NOT NULL,
  last4       text NOT NULL,
  scopes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX credentials_provider_label_key ON credentials (provider, lower(label));

CREATE TRIGGER credentials_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- root_policy is NOT optional and has no "404" member on purpose: a redirect
-- subdomain whose root answers 404 reads as disposable to WhatsApp and Meta
-- scanners and raises the odds of the domain being blocked.
CREATE TABLE domains (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apex              text NOT NULL,
  dns_zone_id       text,
  dns_credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  provider_account  text,
  root_policy       text NOT NULL DEFAULT 'redirect_apex'
                      CHECK (root_policy IN ('redirect_apex', 'branded_page', 'custom_url')),
  root_target       text,
  verified_at       timestamptz,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_custom_url_needs_target
    CHECK (root_policy <> 'custom_url' OR root_target IS NOT NULL)
);

CREATE UNIQUE INDEX domains_apex_key ON domains (lower(apex));

CREATE TRIGGER domains_updated_at
  BEFORE UPDATE ON domains
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subdomains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id       uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  host            text NOT NULL,
  infra_host_id   text,
  record_type     text CHECK (record_type IN ('CNAME', 'A')),
  record_value    text,
  cert_status     text NOT NULL DEFAULT 'pending'
                    CHECK (cert_status IN ('pending', 'issuing', 'valid', 'failed')),
  root_policy     text CHECK (root_policy IN ('redirect_apex', 'branded_page', 'custom_url')),
  root_target     text,
  fallback_url    text,
  health          text NOT NULL DEFAULT 'unknown'
                    CHECK (health IN ('unknown', 'ok', 'degraded', 'down')),
  last_checked_at timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The resolver looks a subdomain up by Host header on every single request:
-- this index is the hot path of the whole product.
CREATE UNIQUE INDEX subdomains_host_key ON subdomains (lower(host));
CREATE INDEX subdomains_domain_idx ON subdomains (domain_id);

CREATE TRIGGER subdomains_updated_at
  BEFORE UPDATE ON subdomains
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign', 'evergreen')),
  description text,
  color       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tags_name_key ON tags (lower(name));

CREATE TRIGGER tags_updated_at
  BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
