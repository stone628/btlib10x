# Avatar gallery: plan (draft, no code yet)

Players submit avatars from the avatar creator (`bt10x.stoneworks.dev/avatar`,
whose "submit to gallery" link opens the gallery's Submit panel) to a public
gallery and upvote each other's. The goal is the safest and
cheapest setup that still feels like a real feature.

The underlying purpose is to collect the 'Mech avatars used in Solaris Rogue:
a submission can say which 'Mech it depicts, and the top-voted avatar per
'Mech is the collected answer (§7 export). Naming the 'Mech is optional;
avatars without one form their own "no 'Mech" group.

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

A submission may name one unit from the Master Unit List (MUL); the field is
optional, and left empty the avatar is stored with no 'Mech. The player pastes
the unit's MUL page URL:

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
and a vote means "this avatar fits this 'Mech". An avatar with no 'Mech is its
own entry (avatar, none), separate from any linked entry of the same avatar;
a vote on it just means "I like this avatar", and the export leaves it out.

## 2. Stack

**Folder layout.** Pages only looks for Functions in `functions/` at the repo
root, so that folder is shared by any sub-project that adds a backend. Each
sub-project keeps everything under its own prefix there, plus a matching
migrations folder and table prefix:

| | avatar gallery (`ag`) | a later sub-project, e.g. the terminal (`term`) |
|---|---|---|
| routes and server code | `functions/api/ag/` (code in `functions/api/ag/_lib/`) | `functions/api/term/` |
| D1 schema | `migrations/ag/` | `migrations/term/` |
| D1 tables | `ag_*` | `term_*` |
| Access rule | `/api/ag/admin` | its own path |

Nothing outside its prefix changes when one sub-project is added or removed.
Files in `_lib/` export no request handlers, so Pages makes no routes from them
(checked with a Wrangler build).

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
| `POST /api/ag/avatars` | device key + Turnstile | `{ q, mul? }`: validate both (empty `mul` = no 'Mech), canonicalize, insert or return the existing (avatar, unit) entry |
| `GET /api/ag/avatars?sort=top\|new&unit=&mine=&cursor=` | none (key for `mine=1`) | a page of `{ id, q, unit, votes, created, by }` (`unit` null when unlinked, `by` the submitter's public ID), optionally for one unit, `unit=none`, or `mine=1`, hidden rows excluded |
| `GET /api/ag/avatars/:id` | none | one entry with its unit's name, MUL URL and image URL |
| `GET /api/ag/units?q=` | none | units that have entries, with entry counts and their top avatar, plus `unlinked: { count, top }` for the no-'Mech group |
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
`functions/api/ag/_lib/config.ts`; you override any of them in the Cloudflare
dashboard (Workers & Pages → the project → Settings → Variables and Secrets).
A change takes effect on the next deployment (redeploy or "Retry deployment").
The repo has no `wrangler.toml` on purpose: once a Pages project has one, it
becomes the source of truth for bindings and variables, and the dashboard
settings above stop applying.

| variable | default | meaning |
|---|---|---|
| `REPORT_HIDE_THRESHOLD` | `3` | reports that auto-hide an entry; `0` turns auto-hide off |
| `AUTO_PUBLISH` | `true` | `false` makes new entries start hidden until you approve them |
| `SUBMITS_PER_DAY` | `10` | submissions per key and per IP per day |
| `VOTES_PER_DAY` | `200` | votes per key and per IP per day |
| `REPORTS_PER_DAY` | `20` | reports per key and per IP per day |
| `KEYS_PER_DAY` | `5` | device keys minted per IP per day |
| `PAGE_SIZE` | `48` | entries per gallery page |
| `ACCESS_TEAM_DOMAIN` | none | Zero Trust team domain, e.g. `stoneworks.cloudflareaccess.com` |
| `ACCESS_AUD` | none | AUD tag of the admin Access application |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAFZV3_ri2orug_FJ` | public Turnstile site key; the page reads it from `GET /api/ag/config` |

Secrets (`TURNSTILE_SECRET`, `IP_HASH_SALT`) go in the same dashboard screen
as encrypted secrets, never in the repo. `functions/api/ag/_lib/config.ts` reads and
validates the settings once per request, falling back to the defaults on a
missing or malformed value. The admin page shows the values in effect.

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
  unit     TEXT REFERENCES ag_units (slug), -- NULL: not tied to a 'Mech
  owner    TEXT NOT NULL,             -- device key hash
  votes    INTEGER NOT NULL DEFAULT 0,
  reports  INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL,          -- unix seconds
  UNIQUE (q, unit)
);
CREATE UNIQUE INDEX ag_avatars_unlinked ON ag_avatars (q) WHERE unit IS NULL;
CREATE INDEX ag_avatars_unit ON ag_avatars (unit, hidden, votes DESC);
CREATE INDEX ag_avatars_top ON ag_avatars (hidden, votes DESC, id DESC);
CREATE INDEX ag_avatars_new ON ag_avatars (hidden, id DESC);

CREATE TABLE ag_keys    (hash TEXT PRIMARY KEY, pid TEXT NOT NULL, created INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ag_votes   (avatar INTEGER NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (avatar, voter));
CREATE TABLE ag_reports (avatar INTEGER NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (avatar, voter));
CREATE TABLE ag_rate    (who TEXT NOT NULL, action TEXT NOT NULL, day INTEGER NOT NULL,
                      n INTEGER NOT NULL, PRIMARY KEY (who, action, day));
```

`UNIQUE (q, unit)` merges duplicate submissions for the same 'Mech into one
entry. SQLite treats NULLs as distinct there, so the partial index
`ag_avatars_unlinked` does the same for avatars with no 'Mech. The vote count is denormalized on `ag_avatars.votes` and updated in the
same D1 batch as the `ag_votes` row. IPs are only ever stored as a salted hash
inside `ag_rate`. Pages Functions have no cron triggers, so `ag_rate` rows
older than three days are pruned opportunistically (about one rate check in
fifty deletes them). `ag_avatars.reviewed` is set when you unhide an entry, so
the same reports cannot hide it again.

## 7. Client

- The avatar creator stays a static page with no gallery code. Its **submit to
  gallery** link opens `gallery.html?submit&head=…`, carrying the avatar in the
  same params as the creator's own URL (plus `lang` when the address bar has it).
- The gallery reads those params and opens the **Submit** panel, a modal over
  the dimmed gallery: the avatar preview, an optional MUL URL field, the
  Turnstile check when Cloudflare asks for one, submit, close, and "edit in
  creator" back to `/avatar` with the same parts. Success shows the entry link
  (or "already in the gallery"). A bad or missing avatar shows only the error,
  "edit in creator" and close. Closing drops the panel's params from the URL.
- Page `web/gallery.html`: Top / New / By 'Mech / No 'Mech tabs, a grid of
  avatar boxes drawn by `composeAvatar` with the 'Mech name under each ("no
  'Mech" in dim italics when unlinked), "by <public ID>" ("by you" on your
  own), and a like toggle (`♡ like · 12` / `♥ liked · 12`; votes in the API).
- Identity without accounts: each device key has a **public ID**, 8 base58
  chars (`publicId` in `avatar.gallery.ts`: SHA-256 of `ag-pid:` + the key
  hash, so it reveals neither the key nor its stored hash). The server stores
  it in `ag_keys.pid` when it mints the key; the page computes its own from
  the key it holds. The header shows "you: 7Hq3xKpa · my avatars" (or "you:
  guest" before the first like or submit), `?mine=1` lists your own
  submissions, and the Submit panel says "submitting as 7Hq3xKpa". Clearing
  site data or switching browsers means a new ID; old entries stay. By 'Mech ends with a
  "no 'Mech" group card; `?unit=none` lists that group.
- Entry page `web/gallery.html?id=<id>`: the avatar large, the 'Mech name, the
  MUL image (hotlinked, placeholder on error), a "View on Master Unit List"
  link, "Open in creator", vote and report, and the other avatars proposed for
  the same 'Mech. An unlinked entry shows "no 'Mech" with no image or MUL link,
  and the other unlinked avatars below.
- `GET /api/ag/export` gives you the collection: for each unit, its name, MUL slug
  and top-voted avatar query, ready to turn into Solaris Rogue avatar data.
- Strings go through `web/avatar/gallery.i18n.ts` (en/ko), like the creator's
  `avatar.i18n.ts`. The admin page is English only.
- Admin page: `web/gallery-admin.html`, copied to `dist/web/avatar/admin.html`
  so it is served at `/avatar/admin`, the path Access guards. It lists
  reported / hidden / all entries with hide, unhide, delete, ban owner and
  fix 'Mech (name, image URL; linked entries only) actions.

## 8. Files

| file | what |
|---|---|
| `migrations/ag/0001_gallery.sql` | schema (§6) |
| `functions/api/ag/config.ts` | public settings for the pages |
| `functions/api/ag/keys.ts` | mint a device key (Turnstile) |
| `functions/api/ag/avatars/index.ts` | list, submit |
| `functions/api/ag/avatars/[id].ts` | one entry; owner delete |
| `functions/api/ag/avatars/[id]/vote.ts`, `report.ts` | vote toggle, report |
| `functions/api/ag/units.ts`, `export.ts` | 'Mechs with entries, collection export |
| `functions/api/ag/admin/[[path]].ts` | admin routes |
| `functions/api/ag/_lib/` | `cf.ts` (hand-written D1/Pages types), `config.ts` (§5a), `http.ts`, `auth.ts` (device keys, IP hash), `rate.ts`, `turnstile.ts`, `mul.ts` (MUL fetch and parsing), `access.ts` (Access JWT check), `gallery.ts` (queries) |
| `web/avatar/avatar.gallery.ts` | shared by pages and functions: avatar validation and canonical form, MUL URL parsing, slug prettifier |
| `web/avatar/avatar.compose.ts` | avatar box drawing, moved out of `avatar.ts` so the server can import it |
| `web/avatar/gallery.client.ts`, `gallery.i18n.ts` | browser API client (device key, Turnstile), strings |
| `web/gallery.html`, `web/gallery.css`, `web/avatar/gallery.ts` | gallery page |
| `web/avatar/gallery.submit.ts` | the gallery's Submit panel (`?submit&head=…`) |
| `web/gallery-admin.html`, `web/avatar/gallery.admin.ts` | admin page |
| `web/avatar.html`, `web/avatar/avatar.ts` | creator: static "submit to gallery" and gallery links |
| `scripts/build-web.mjs`, `scripts/dist-web.mjs` | bundle and ship the gallery pages |
| `tests/gallery.test.ts` | validation, canonical form, MUL URL and page parsing |
| `tests/gallery-api.test.ts` | the API end to end over the real migration in `node:sqlite`, with Turnstile, MUL and Access stubbed |

## 9. Setup you do once in the Cloudflare dashboard

1. Create a D1 database and bind it to the Pages project as `DB`.
2. Create a Turnstile widget for `bt10x.stoneworks.dev` (Managed mode).
   Done: site key `0x4AAAAAAFZV3_ri2orug_FJ`, the default of
   `TURNSTILE_SITE_KEY` in `config.ts` (public). Add the secret key as the encrypted
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

4. Create the tables once (from the repo root, signed in with `npx wrangler login`):
   `npx wrangler d1 execute <database-name> --remote --file=migrations/ag/0001_gallery.sql`.
   The statements use `IF NOT EXISTS`, so running it again is harmless.

### Local development

Wrangler is not a dev dependency (zero-dependency rule), so `npx` fetches it.
From the repo root:

1. Create `.dev.vars` (gitignored) with Cloudflare's always-pass Turnstile
   test pair, so the human check works on `localhost`:

   ```
   TURNSTILE_SITE_KEY=1x00000000000000000000AA
   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
   IP_HASH_SALT=local-dev-salt
   ```

2. Build the site: `npm run dist:web`.
3. Create the local tables (once; kept in `.wrangler/state`, gitignored):
   `npx wrangler d1 execute DB --local -c migrations/ag/wrangler.local.toml --persist-to .wrangler/state --file=migrations/ag/0001_gallery.sql`
4. Serve: `npx wrangler pages dev dist/web --d1 DB=ag-local`, then open
   `http://localhost:8788/avatar` and `http://localhost:8788/gallery`.

`migrations/ag/wrangler.local.toml` only tells `d1 execute` where the local
database is; `--d1 DB=ag-local` gives `pages dev` the same one. Keep any
`wrangler.toml` out of the repo root (see §5a). Submitting fetches the MUL page
for real, so it needs network. Admin routes refuse locally, since
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` only make sense behind Access on the real
domain. To start over, delete `.wrangler/state` and repeat step 3.

## 10. Defaults picked, in one list

- Pages Functions + D1 + Turnstile, all free tier.
- Submission is the canonical avatar query plus an optional MUL unit URL; no
  names or free text.
- An entry is an (avatar, 'Mech) pair, or an avatar with no 'Mech; votes mean
  "fits this 'Mech" (or just "good avatar" when unlinked).
- The creator is static; submitting happens on the gallery page.
- MUL name and image URL are fetched once per unit and cached; the image is
  hotlinked, never copied.
- Anonymous device key for players; Cloudflare Access for admin.
- Auto-publish, hide at 3 reports.
- Votes are toggles, one per key; 10 submits and 200 votes per day per key/IP.
