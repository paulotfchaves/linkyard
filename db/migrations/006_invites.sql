-- 006_invites.sql — joining an installation that owns no mail transport.
--
-- Linkyard sends no email. Adding SMTP would mean another credential in the
-- vault, a deliverability problem, and a bounce queue — for a product whose
-- entire job is answering a redirect in under 50ms. An invite is therefore a
-- link the inviter copies and delivers over whatever channel they already use
-- to talk to the person.
--
-- That makes the token a bearer credential, so it is stored the way the session
-- token is: SHA-256 of 256 bits of machine randomness, never the value itself.
-- A database dump yields digests nobody can redeem.

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  -- No 'owner' member. Ownership is transferred by an explicit, audited action
  -- against an account that already exists; handing it to whoever opens a link
  -- would put the whole installation behind a URL in somebody's chat history.
  role        text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash  text NOT NULL,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  -- One direction only, and deliberately not the other. Redemption stamps
  -- accepted_at first, because that conditional UPDATE is what makes exactly one
  -- of two simultaneous redeemers win; the account it attributes to does not
  -- exist until the claim has been won. Requiring both columns together would
  -- forbid that order for a state no other session can observe, since the whole
  -- redemption is one transaction.
  CONSTRAINT invites_redeemer_needs_acceptance
    CHECK (accepted_by IS NULL OR accepted_at IS NOT NULL)
);

CREATE UNIQUE INDEX invites_token_hash_key ON invites (token_hash);

-- One live invite per address, enforced here rather than in the panel: two
-- valid tokens for the same seat means revoking the one you can see while the
-- other keeps working.
CREATE UNIQUE INDEX invites_pending_email_key
  ON invites (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The pending list and the expiry sweep read the same predicate.
CREATE INDEX invites_pending_idx ON invites (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
