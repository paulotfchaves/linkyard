-- 001_identity.sql — who can sign in and what they may do.
--
-- Roles set the baseline; grants are ADDITIVE ONLY — they widen what a role
-- allows and never narrow it. Restriction is expressed as "low role + targeted
-- grant", never as a deny rule. A permission model that both widens and narrows
-- is where authorization bugs come from.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  timezone      text NOT NULL DEFAULT 'UTC',
  locale        text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'pt-BR')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Email is the login: uniqueness must ignore case, or Ana@ and ana@ become two
-- accounts the login form cannot tell apart.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- scope_domain_id NULL means "every domain". A grant never removes access.
CREATE TABLE grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource        text NOT NULL CHECK (resource IN ('domain', 'subdomain', 'link')),
  action          text NOT NULL CHECK (action IN ('create', 'read', 'update', 'delete')),
  scope_domain_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX grants_unique ON grants (
  user_id,
  resource,
  action,
  coalesce(scope_domain_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO settings (key, value) VALUES
  ('click_retention_days',  '180'::jsonb),
  ('default_locale',        '"en"'::jsonb),
  ('default_redirect_type', '302'::jsonb)
ON CONFLICT (key) DO NOTHING;
