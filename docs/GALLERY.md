# Avatar gallery: plan (draft, no code yet)

Players submit avatars from the avatar creator (`bt10x.stoneworks.dev/avatar`)
to a public gallery and upvote each other's. The goal is the safest and
cheapest setup that still feels like a real feature.

The underlying purpose is to collect the 'Mech avatars used in Solaris Rogue:
every submission says which 'Mech it depicts, and the top-voted avatar per
'Mech is the collected answer (§7 export).

## 1. Why this is cheap to make safe

An avatar is already a short, fully validated string: the query that
`web/avatar/avatar.url.ts` builds and parses.

    head=sq&shoulder=rn&torso=bt&arms=pr&legs=sf&rh=2622&la=23ac

- Five part params, each a known variant name from `avatar.data.ts`.
- Up to ten slot overrides (`rh lh rs ls ra la rt lt rl ll`), each one glyph
  that `isAllowedGlyph` accepts (the ~1,430 code points the subset font maps).

A submission is exactly that string and nothing else. The server rejects
anything `parseAvatarQuery` reports in `ignored`, then stores the
re-serialized `buildAvatarQuery` output. The gallery renders entries with the
existing box composer, so no user-supplied HTML, image or free text ever
reaches the page.

The only content risk left is spelling words with Basic Latin letters across
the override cells. That is handled by reports and a hide switch (§5).

## 1a. Which 'Mech the avatar is for

Every submission names one unit from the Master Unit List (MUL). The player
pastes the unit's MUL page URL:

    https://masterunitlist.battletech.com/units/atlas-as7-d-dc

Checked 2026-10-17 on that page: the URL slug is the unit's only identifier
(no numeric id on the page), the title is the unit name ("Atlas AS7-D-DC"),
and the unit art is both the `<img>` and the `og:image`:

    https://masterunitlist.battletech.com/point-backs/unit-art/manual/atlas-60d7b0.webp

The art is per chassis (`atlas-…`), so variants of one 'Mech share a picture.
There is also a per-variant Alpha Strike card at `/units/<slug>/card.png`; the
gallery uses the unit art, not the card.

- **Validation.** The server accepts only `masterunitlist.battletech.com/units/<slug>`
  with `<slug>` matching `^[a-z0-9]+(-[a-z0-9]+)*$` (80 chars max), and keeps
  just the slug. Nothing else from the field is stored, so it is no more of a
  free-text risk than the avatar itself.
- **Name and image.** On the first submission for a slug, the server fetches
  that MUL page once and reads `og:title` (or `<title>`) and `og:image`. A 404
  rejects the submission as "not a MUL unit". The result is cached in the
  `ag_units` table (§6), so MUL sees one request per unit, ever. The image URL is
  accepted only if it is on `masterunitlist.battletech.com`.
- **If MUL can't be read** (down, blocks Cloudflare, or changes its markup),
  the submission still succeeds: the name falls back to the slug
  (`atlas-as7-d-dc` shown as "Atlas AS7-D-DC"), the image is left empty, and
  you can fill or fix both in the admin page. Not verified yet: whether MUL
  answers requests from Cloudflare's network. Plain fetches from this
  project's cloud sandbox were refused, while a fetch through a web reader
  worked.
- **Image is hotlinked, never copied.** The entry page shows MUL's own image
  URL in an `<img>` with `referrerpolicy="no-referrer"` and a plain
  placeholder on error, plus a "View on Master Unit List" link. The artwork
  stays on Catalyst's servers and the gallery stores only the URL, which keeps
  it in line with the fan-policy notes in the IP audit.
- **Picker (later).** A name search would be friendlier than pasting URLs. The
  MUL page mentions a unit index it loads in the browser, but its URL was not
  found; failing that, the repo's own `docs/mtf` catalog can back the search.
  Either way the stored data (the slug) stays the same.

The same avatar can be proposed for different 'Mechs, and different avatars
for the same 'Mech. The gallery entry is therefore the pair (avatar, unit),
and a vote means "this avatar fits this 'Mech".

## 2. Stack

Everything stays on the existing Cloudflare Pages project, on free tiers.

| piece | use | free tier |
|---|---|---|
| Pages Functions (`functions/api/ag/`) | the API, same origin as the site, no CORS | 100k requests/day |
| D1 | avatars, votes, reports | 5 GB, 5M reads/day, 100k writes/day |
| Turnstile | bot check on submit (and on first vote) | free, unlimited |
| Cloudflare Access | protects the admin routes (§4) | free up to 50 users |

No separate Worker, no server, no paid services. The functions import the
same `avatar.url.ts`, `avatar.override.ts` and `avatar.data.ts` the page uses,
so client and server can never disagree on what is valid.

## 3. API

Every gallery route lives under `/api/ag/` (ag = avatar gallery, like the
`ag_` tables), so other server features, for example for the bt10x terminal,
can take their own prefix (`/api/term/...`) without colliding. The Access
application (§9) covers only `/api/ag/admin`, so it never captures routes
outside the gallery.

| route | auth | does |
|---|---|---|
| `POST /api/ag/avatars` | device key + Turnstile | `{ q, mul }`: validate both, canonicalize, insert or return the existing (avatar, unit) entry |
| `GET /api/ag/avatars?sort=top\|new&unit=&cursor=` | none | a page of `{ id, q, unit, votes, created }`, optionally for one unit, hidden rows excluded |
| `GET /api/ag/avatars/:id` | none | one entry with its unit's name, MUL URL and image URL |
| `GET /api/ag/units?q=` | none | units that have entries, with entry counts and their top avatar |
| `GET /api/ag/config` | none | public settings the page needs: Turnstile site key, page size |
| `GET /api/ag/export` | none | top-voted avatar per unit as JSON, for the Solaris Rogue collection |
| `POST /api/ag/avatars/:id/vote` | device key | one vote per voter; calling again removes it |
| `POST /api/ag/avatars/:id/report` | device key | one report per voter; auto-hides at a threshold |
| `DELETE /api/ag/avatars/:id` | device key (owner) | owner removes their own submission |
| `GET/POST/DELETE /api/ag/admin/*` | Cloudflare Access | list reported, hide/unhide, delete an entry, ban a voter |

Rate limits (per IP hash, per device key): 10 submits/day, 200 votes/day.
D1 enforces them with a small `ag_rate` table keyed by `(who, action, day)`.

## 4. Authentication

Default picked: **anonymous device key for players, Cloudflare Access for
you.** Players never sign up and the gallery stores no personal data.

### Options considered

1. **No identity, Turnstile only.** Votes keyed by a random browser ID in
   `localStorage`. Simplest, but anyone can clear storage and vote again, and
   nobody can delete their own submission.
2. **Anonymous device key (picked).** On first use the page asks the server
   for a key: a random 256-bit secret kept in `localStorage`, sent as a
   bearer header. The server stores only its SHA-256 hash, so a leaked
   database exposes nothing usable. Minting a key needs Turnstile, so making
   many keys costs a bot real effort. The key owns submissions (delete your
   own) and votes (one per key). A "copy my key" / "paste key" button moves
   it to another device. About 40 lines of server code.
3. **Passkeys (WebAuthn).** Real accounts with no password and no email,
   synced across the player's devices by their OS. Strongest abuse
   resistance of the no-PII options, but several hundred lines (or a small
   library) and a sign-in step players have to understand.
4. **OAuth with GitHub or Discord.** One provider, a signed session cookie,
   store only the provider's numeric user ID. Good fit if the player
   community lives on Discord. Costs an app registration, a callback route,
   and a login button between the player and their first vote.
5. **Email magic link.** Needs an email sender (for example Resend's free
   tier) and stores email addresses, which brings privacy obligations.
   Not recommended for this.

Upgrade path: option 2 now; if vote manipulation shows up, add option 4 as
"sign in to make your votes count" and weight or filter anonymous votes,
without breaking existing keys.

### Admin

`/api/ag/admin/*` and a small `/avatar/admin` page sit behind a Cloudflare
Access policy that allows only your email. Access does the login (one-time
PIN or GitHub), and the function checks the `Cf-Access-Jwt-Assertion`
header, so there is no admin password in the codebase.

## 5. Moderation

Default picked: **auto-publish**, since validation already rules out almost
all bad content.

- Any key can report an entry once. At 3 reports it is hidden until you
  review it in the admin page.
- You can hide/unhide any entry and ban a key hash (its submissions are
  hidden and its votes stop counting).
- You can also delete any entry outright. That removes the row with its votes
  and reports in one D1 batch and cannot be undone, so the admin page asks to
  confirm. Hide is the everyday tool; delete is for content you never want
  back. A deleted (avatar, 'Mech) pair can be submitted again, so for repeat
  offenders ban the key instead.
- Switching to approve-first later is one flag: new rows start with
  `hidden = 1`.

## 5a. Settings

All tunable numbers are Pages environment variables. Defaults live in
`wrangler.toml` under `[vars]`; you override any of them in the Cloudflare
dashboard (Workers & Pages → the project → Settings → Variables and Secrets).
A change takes effect on the next deployment (redeploy or "Retry deployment").

| variable | default | meaning |
|---|---|---|
| `REPORT_HIDE_THRESHOLD` | `3` | reports that auto-hide an entry; `0` turns auto-hide off |
| `AUTO_PUBLISH` | `true` | `false` makes new entries start hidden until you approve them |
| `SUBMITS_PER_DAY` | `10` | submissions per key and per IP per day |
| `VOTES_PER_DAY` | `200` | votes per key and per IP per day |
| `REPORTS_PER_DAY` | `20` | reports per key and per IP per day |
| `PAGE_SIZE` | `48` | entries per gallery page |
| `ACCESS_TEAM_DOMAIN` | none | Zero Trust team domain, e.g. `stoneworks.cloudflareaccess.com` |
| `ACCESS_AUD` | none | AUD tag of the admin Access application |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAFZV3_ri2orug_FJ` | public Turnstile site key; the page reads it from `GET /api/ag/config` |

Secrets (`TURNSTILE_SECRET`, `IP_HASH_SALT`) go in the same dashboard screen
as encrypted secrets, never in `wrangler.toml`. `functions/_lib/config.ts`
reads and validates them once per request, falling back to the defaults on a
missing or malformed value.

Later, if you want to change these without redeploying, the same keys can move
to a one-row `ag_settings` table edited from the admin page.

## 6. Data model (D1)

```sql
-- Every table and index is prefixed ag_ (avatar gallery), so the gallery
-- can share a D1 database with anything else without name clashes.
CREATE TABLE ag_units (
  slug     TEXT PRIMARY KEY,          -- MUL /units/<slug>, e.g. atlas-as7-d-dc
  name     TEXT NOT NULL,             -- from MUL, or prettified slug
  image    TEXT,                      -- MUL image URL, hotlinked; NULL if unknown
  fetched  INTEGER                    -- when MUL was last read; NULL if it failed
);

CREATE TABLE ag_avatars (
  id       INTEGER PRIMARY KEY,
  q        TEXT NOT NULL,             -- canonical buildAvatarQuery output
  unit     TEXT NOT NULL REFERENCES ag_units (slug),
  owner    TEXT NOT NULL,             -- device key hash
  votes    INTEGER NOT NULL DEFAULT 0,
  reports  INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL,          -- unix seconds
  UNIQUE (q, unit)
);
CREATE INDEX ag_avatars_unit ON ag_avatars (unit, hidden, votes DESC);
CREATE INDEX ag_avatars_top ON ag_avatars (hidden, votes DESC, id DESC);
CREATE INDEX ag_avatars_new ON ag_avatars (hidden, id DESC);

CREATE TABLE ag_keys    (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ag_votes   (avatar INTEGER NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (avatar, voter));
CREATE TABLE ag_reports (avatar INTEGER NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (avatar, voter));
CREATE TABLE ag_rate    (who TEXT NOT NULL, action TEXT NOT NULL, day INTEGER NOT NULL,
                      n INTEGER NOT NULL, PRIMARY KEY (who, action, day));
```

`UNIQUE (q, unit)` merges duplicate submissions for the same 'Mech into one
entry. The vote count is denormalized on `ag_avatars.votes` and updated in the
same D1 batch as the `ag_votes` row. IPs are only ever stored as a salted hash
inside `ag_rate`, and `ag_rate` rows older
than a few days are deleted by a daily cron trigger.

## 7. Client

- Avatar creator gains a **Submit** button next to copy. It asks for the MUL
  URL of the 'Mech, posts both, and shows the entry link on success (or
  "already in the gallery").
- New page `web/gallery.html`: Top / New / By 'Mech tabs, a grid of avatar
  boxes drawn by `composeAvatar` with the 'Mech name under each, a vote toggle
  and a report menu per entry.
- Entry page `web/gallery.html?id=<id>`: the avatar large, the 'Mech name, the
  MUL image (hotlinked, placeholder on error), a "View on Master Unit List"
  link, "Open in creator", vote and report, and the other avatars proposed for
  the same 'Mech.
- `GET /api/ag/export` gives you the collection: for each unit, its name, MUL slug
  and top-voted avatar query, ready to turn into Solaris Rogue avatar data.
- Strings go through `avatar.i18n.ts` (en/ko) like the rest of the avatar UI.

## 8. Files

| file | change |
|---|---|
| `functions/api/ag/avatars/index.ts` | list, submit |
| `functions/api/ag/avatars/[id]/vote.ts`, `report.ts`, `[id].ts` | vote, report, delete |
| `functions/api/ag/keys.ts` | mint a device key (Turnstile) |
| `functions/api/ag/units.ts`, `export.ts` | units with entries, collection export |
| `functions/_lib/mul.ts` | MUL URL parsing, one-time page fetch (`og:title`, `og:image`), slug prettifier |
| `functions/api/ag/admin/[[path]].ts` | admin routes, Access JWT check |
| `functions/_lib/` | D1 helpers, key hashing, rate limits, Turnstile verify, `config.ts` (§5a) |
| `migrations/0001_gallery.sql` | schema above |
| `wrangler.toml` | D1 binding, `[vars]` defaults (§5a) |
| `web/gallery.html`, `web/avatar/gallery.ts` | gallery page |
| `web/avatar/avatar.ts` | Submit button |
| `tests/gallery.test.ts` | validation, canonicalization, vote toggle, rate limit (Miniflare D1) |

## 9. Setup you do once in the Cloudflare dashboard

1. Create a D1 database and bind it to the Pages project as `DB`.
2. Create a Turnstile widget for `bt10x.stoneworks.dev` (Managed mode).
   Done: site key `0x4AAAAAAFZV3_ri2orug_FJ`, set as `TURNSTILE_SITE_KEY`
   in `wrangler.toml` `[vars]` (public). Add the secret key as the encrypted
   secret `TURNSTILE_SECRET` (Production and Preview); never commit it.
   For local dev, `.dev.vars` (gitignored) uses Cloudflare's always-pass test
   pair: site key `1x00000000000000000000AA`, secret
   `1x0000000000000000000000000000000AA`.
3. Add a Cloudflare Access application for `/api/ag/admin/*` and
   `/avatar/admin*` allowing your email.
   Copy its Application Audience (AUD) tag into `ACCESS_AUD` and the team
   domain (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`, both as
   plain variables. The admin function verifies the `Cf-Access-Jwt-Assertion`
   JWT against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and
   that AUD, and refuses the request when either is missing, so `*.pages.dev`
   preview URLs (which Access does not cover) fail closed.

## 10. Defaults picked, in one list

- Pages Functions + D1 + Turnstile, all free tier.
- Submission is the canonical avatar query plus a MUL unit URL; no names or
  free text.
- An entry is an (avatar, 'Mech) pair; votes mean "fits this 'Mech".
- MUL name and image URL are fetched once per unit and cached; the image is
  hotlinked, never copied.
- Anonymous device key for players; Cloudflare Access for admin.
- Auto-publish, hide at 3 reports.
- Votes are toggles, one per key; 10 submits and 200 votes per day per key/IP.
