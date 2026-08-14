-- 006_temporary_redirects_only.sql — remove the permanent redirect types.
--
-- 301 and 308 are cached by the browser, and by some shared caches, until the
-- cache is cleared. A link whose destination changes — which is the single
-- promise this product makes — would never reach anyone who already clicked.
-- Cache-Control: no-store does not reliably undo that; Safari and corporate
-- caches have historically kept permanent redirects regardless.
--
-- Offering the choice in the panel meant an operator could permanently break
-- that promise from a dropdown, with no way to repair it for the browsers that
-- already stored the answer. So the choice stops existing.
--
-- Existing rows are moved to their temporary equivalent: 301 -> 302, 308 -> 307.

UPDATE links SET redirect_type = 302 WHERE redirect_type = 301;
UPDATE links SET redirect_type = 307 WHERE redirect_type = 308;

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_redirect_type_check;
ALTER TABLE links
  ADD CONSTRAINT links_redirect_type_check CHECK (redirect_type IN (302, 307));
