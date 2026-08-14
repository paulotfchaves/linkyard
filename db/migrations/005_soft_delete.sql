-- 005_soft_delete.sql — a deleted link stops resolving without ceasing to exist.
--
-- Hard deletion throws away the click history and the version trail of a link
-- that may be printed on a flyer somebody still has. Soft deletion keeps both
-- and buys back the only thing an operator actually wants from a delete: the
-- slug.

ALTER TABLE links ADD COLUMN deleted_at timestamptz;

-- Uniqueness has to ignore deleted rows, and that is the whole point of this
-- migration: after deleting /promo the operator must be able to create /promo
-- again, while the old link keeps its history under the same name. A total
-- unique index would refuse the second link forever and turn every delete into
-- a permanent reservation of the slug.
DROP INDEX links_subdomain_slug_key;
CREATE UNIQUE INDEX links_subdomain_slug_key
  ON links (subdomain_id, lower(slug))
  WHERE deleted_at IS NULL;

-- Every listing in the panel is "the live ones, newest first". The predicate
-- belongs in the index so deleted rows are never scanned to be discarded.
CREATE INDEX links_live_idx ON links (created_at DESC) WHERE deleted_at IS NULL;

-- The trash view reads the other side of the same predicate.
CREATE INDEX links_deleted_idx ON links (deleted_at DESC) WHERE deleted_at IS NOT NULL;
