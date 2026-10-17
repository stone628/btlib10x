-- Avatar gallery schema (docs/GALLERY.md §6). Every table and index is
-- prefixed ag_ (avatar gallery) so the gallery can share a D1 database with
-- other features without name clashes.
--
-- Apply once: npx wrangler d1 execute <database-name> --remote --file=migrations/ag/0001_gallery.sql

CREATE TABLE IF NOT EXISTS ag_units (
  slug     TEXT PRIMARY KEY,          -- MUL /units/<slug>, e.g. atlas-as7-d-dc
  name     TEXT NOT NULL,             -- from MUL, or prettified slug
  image    TEXT,                      -- MUL image URL, hotlinked; NULL if unknown
  fetched  INTEGER                    -- when MUL was last read; NULL if it failed
);

CREATE TABLE IF NOT EXISTS ag_avatars (
  id       INTEGER PRIMARY KEY,
  q        TEXT NOT NULL,             -- canonical avatar query (web/avatar/avatar.gallery.ts)
  unit     TEXT REFERENCES ag_units (slug), -- NULL: not tied to a 'Mech
  owner    TEXT NOT NULL,             -- device key hash
  votes    INTEGER NOT NULL DEFAULT 0,
  reports  INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0, -- admin unhid it: reports no longer auto-hide
  created  INTEGER NOT NULL,          -- unix seconds
  UNIQUE (q, unit)
);
-- UNIQUE (q, unit) treats NULL units as distinct; this merges unlinked duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ag_avatars_unlinked ON ag_avatars (q) WHERE unit IS NULL;
CREATE INDEX IF NOT EXISTS ag_avatars_unit ON ag_avatars (unit, hidden, votes DESC);
CREATE INDEX IF NOT EXISTS ag_avatars_top ON ag_avatars (hidden, votes DESC, id DESC);
CREATE INDEX IF NOT EXISTS ag_avatars_new ON ag_avatars (hidden, id DESC);
CREATE INDEX IF NOT EXISTS ag_avatars_owner ON ag_avatars (owner);

CREATE TABLE IF NOT EXISTS ag_keys (
  hash     TEXT PRIMARY KEY,
  pid      TEXT NOT NULL,             -- public ID shown as "by …" (avatar.gallery.ts publicId)
  created  INTEGER NOT NULL,
  banned   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ag_votes (
  avatar   INTEGER NOT NULL,
  voter    TEXT NOT NULL,
  PRIMARY KEY (avatar, voter)
);
CREATE INDEX IF NOT EXISTS ag_votes_voter ON ag_votes (voter);
CREATE TABLE IF NOT EXISTS ag_reports (
  avatar   INTEGER NOT NULL,
  voter    TEXT NOT NULL,
  PRIMARY KEY (avatar, voter)
);
CREATE TABLE IF NOT EXISTS ag_rate (
  who      TEXT NOT NULL,             -- key hash or salted IP hash
  action   TEXT NOT NULL,
  day      INTEGER NOT NULL,          -- unix day number
  n        INTEGER NOT NULL,
  PRIMARY KEY (who, action, day)
);
