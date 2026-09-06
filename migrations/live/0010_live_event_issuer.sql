-- Public issuer label shown on claim and collection surfaces.
-- Existing events belong to the association; new event bundles persist their
-- own issuer so the interface never relies on a hard-coded footer.

ALTER TABLE live_events ADD COLUMN issuer TEXT NOT NULL DEFAULT '兆量富足教育協會'
  CHECK (length(issuer) BETWEEN 1 AND 160);
