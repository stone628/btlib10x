-- Gallery cache version (docs/GALLERY.md §3a, §6). One counter that every
-- write changing what the public reads return bumps in the same D1 batch.
-- The public GET routes put it in their edge cache key and their ETag, so a
-- bump makes every cached copy unreachable at once, in every data center,
-- without purging anything.
--
-- Apply once, before deploying the code that reads it:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/ag/0002_cache_version.sql

CREATE TABLE IF NOT EXISTS ag_meta (
  k        TEXT PRIMARY KEY,          -- setting name; only 'version' so far
  v        INTEGER NOT NULL
);
INSERT INTO ag_meta (k, v) VALUES ('version', 1) ON CONFLICT (k) DO NOTHING;
