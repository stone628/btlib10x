# Avatar gallery

Players submit avatars made in the avatar creator (`bt10x.stoneworks.dev/avatar`)
to a public gallery (`/gallery`) and like each other's. It runs entirely on
the site's Cloudflare Pages project, on free tiers, with no accounts.

A submission can say which 'Mech it depicts, so players can find the
best-fitting avatar for each 'Mech. Naming the 'Mech is optional; avatars
without one form their own "no 'Mech" group.

## 1. Why submissions are safe

An avatar is a short, fully validated string: the query that
`web/avatar/avatar.url.ts` builds and parses.

    head=sq&shoulder=rn&torso=bt&arms=pr&legs=sf&rh=2622&la=23ac

- Five part params, each a known variant name from `avatar.data.ts`.
- Up to ten slot overrides (`rh lh rs ls ra la rt lt rl ll`), each one glyph
  that `isAllowedGlyph` accepts (the ~1,430 code points the subset font maps).

A submission is exactly that string plus an optional MUL link (§1a), nothing
else. `canonicalAvatar` (`web/avatar/avatar.gallery.ts`) rejects unknown or
repeated params, missing parts and anything `parseAvatarQuery` reports in
`ignored`, drops overrides that repeat the variant's own glyph, and stores the
re-serialized `buildAvatarQuery` output, so two queries that draw the same
avatar store as the same string. The gallery draws entries with the creator's
own box composer, so no user-supplied HTML, image or free text reaches a page.

The only content risk left is spelling words with Basic Latin letters across
the override cells. Reports and moderation handle that (§5).

## 1a. Which 'Mech the avatar is for

A submission may name one unit from the Master Unit List (MUL) by pasting the
unit's page URL; left empty, the avatar is stored with no 'Mech.

    https://masterunitlist.battletech.com/units/atlas-as7-d-dc

The URL slug is the unit's only identifier on MUL, the page title is the unit
name ("Atlas AS7-D-DC"), and the unit art is the page's `og:image`:

    https://masterunitlist.battletech.com/point-backs/unit-art/manual/atlas-60d7b0.webp

The art is per chassis (`atlas-…`), so variants of one 'Mech share a picture.

- **Validation.** Only `masterunitlist.battletech.com/units/<slug>` is
  accepted, with `<slug>` matching `^[a-z0-9]+(-[a-z0-9]+)*$` (80 chars max).
  Just the slug is stored.
- **Name and image.** On the first submission for a slug the server fetches
  that MUL page once and reads `og:title` (or `<title>`) and `og:image`. A 404
  rejects the submission as an unknown unit. The result is cached in
  `ag_units` (§6), so MUL sees one request per unit, ever. The image URL is
  kept only if it is on `masterunitlist.battletech.com`.
- **If MUL can't be read** (down, blocking Cloudflare, or changed markup), the
  submission still succeeds: the name falls back to the prettified slug
  (`atlas-as7-d-dc` shown as "Atlas AS7-D-DC"), the image stays empty, and the
  admin page can fix both. Still unverified: whether MUL answers requests from
  Cloudflare's network.
- **Images are hotlinked, never copied.** Pages show MUL's own image URL with
  `referrerpolicy="no-referrer"`, a placeholder on error, and a "view on
  Master Unit List" link. The artwork stays on Catalyst's servers.

An entry is the pair (avatar, 'Mech), so the same avatar can be proposed for
different 'Mechs and a like means "this avatar fits this 'Mech". An avatar with
no 'Mech is its own entry, separate from any linked entry of the same avatar;
a like on it just means "good avatar".

## 2. Stack

Everything stays on the existing Cloudflare Pages project.

| piece | use | free tier |
|---|---|---|
| Pages Functions (`functions/api/ag/`) | the API, same origin as the site, no CORS | 100k requests/day |
| D1 | avatars, likes, reports, keys, rate counters | 5 GB, 5M reads/day, 100k writes/day |
| Turnstile | bot check when minting a device key and on every submission | free |
| Cloudflare Access | protects the admin page and routes (§4) | free up to 50 users |

The functions import `web/avatar/avatar.gallery.ts`, which builds on the same
`avatar.url.ts`, `avatar.override.ts` and `avatar.data.ts` the pages use, so
client and server never disagree on what is valid.

**Folder layout.** Pages only looks for Functions in `functions/` at the repo
root, so that folder is shared by any sub-project that adds a backend. Each
sub-project keeps everything under its own prefix, plus a matching migrations
folder and table prefix:

| | avatar gallery (`ag`) | a later sub-project, e.g. the terminal (`term`) |
|---|---|---|
| routes and server code | `functions/api/ag/` (helpers in `functions/api/ag/_lib/`) | `functions/api/term/` |
| D1 schema | `migrations/ag/` | `migrations/term/` |
| D1 tables | `ag_*` | `term_*` |
| Access rule | `/api/ag/admin` | its own path |

Nothing outside its prefix changes when a sub-project is added or removed.
Files in `_lib/` export no request handlers, so Pages makes no routes from them.

## 3. API

| route | auth | does |
|---|---|---|
| `GET /api/ag/config` | none | public settings: `turnstileSiteKey`, `pageSize`, `autoPublish` |
| `POST /api/ag/keys` | Turnstile | `{ turnstile }`: mint a device key; returns `{ key, pid }` once |
| `GET /api/ag/keys` | device key | check a key moved from another browser: `{ pid }`, or `no_key` / `banned` |
| `POST /api/ag/avatars` | device key + Turnstile | `{ q, mul?, turnstile }`: validate, canonicalize, insert, or return the existing entry (`existing: true`) |
| `GET /api/ag/avatars?sort=top\|new&unit=&mine=1&cursor=` | none (key for `mine=1`) | a page of `{ id, q, unit, votes, created, by, voted, mine }`; `unit` is null when unlinked, `by` the submitter's public ID. Filter by one unit slug, `unit=none` (no 'Mech) or `mine=1` (your own). Hidden entries excluded |
| `GET /api/ag/avatars/:id` | none | one visible entry; a hidden one (awaiting approval, reported, banned) is `404 under_review` without its avatar, a missing one `404 not_found` |
| `DELETE /api/ag/avatars/:id` | device key (owner) | the submitter removes their entry |
| `POST /api/ag/avatars/:id/vote` | device key | toggle your like |
| `POST /api/ag/avatars/:id/report` | device key | report once; auto-hides at the threshold (§5) |
| `GET /api/ag/units?q=` | none | 'Mechs with visible entries, their counts and top avatar, plus `unlinked: { count, top }` for the no-'Mech group |
| `/api/ag/admin/*` | Cloudflare Access | `GET me`; `GET entries?filter=reported\|hidden\|all`; `POST entries/:id/hide`, `unhide`, `ban-owner`; `DELETE entries/:id`; `PUT units/:slug { name, image }`; `GET export` (most-liked avatar per 'Mech, ties to the earliest) |

Votes are called likes on the pages; the API and tables keep the name `votes`.

Rate limits are counted per device key and per salted IP hash in `ag_rate`
(defaults in §5a): submissions, likes and reports per day, and new keys per
IP per day. Re-submitting an entry that already exists costs nothing.

## 4. Identity and authentication

**Players: anonymous device key.** On a player's first like, report or
submission, the page passes a Turnstile check and asks `POST /api/ag/keys`
for a key: a random 256-bit secret kept in `localStorage`
(`bt10x.ag.key`) and sent as `Authorization: Bearer <key>`. The server stores
only its SHA-256 hash, so a leaked database holds nothing usable. The key owns
submissions (the owner can delete them) and likes (one per key per entry).
Players never sign up and the gallery stores no personal data.

**Public ID.** Each key has a public ID of 8 base58 characters (`publicId` in
`avatar.gallery.ts`: SHA-256 of `ag-pid:` plus the key hash), which reveals
neither the key nor its stored hash. The server stores it in `ag_keys.pid`
when it mints the key; the page computes its own from the key it holds. Pages
show it as "you: 7Hq3xKpa" and "by 7Hq3xKpa".

Clearing site data or switching browsers means a new key and a new ID; old
entries stay but no longer show as yours, unless the key was moved first.

**Moving a key.** The gallery's key panel ("move key" next to your ID, "use a
key" for a guest) shows this browser's key with **copy key** and **copy link**
(`gallery.html#key=<key>`). On the other browser the player pastes either into
"use a key from another browser", or opens the link, which fills it in. The
page checks the key with `GET /api/ag/keys` and only then stores it, replacing
that browser's own key (the panel warns with the ID being replaced). The key
travels in the URL fragment, which browsers never send to a server, and the
page removes the fragment as soon as it reads it. Both browsers then act as
the same player; there is no way to revoke a copy short of an admin ban.

**Admin: Cloudflare Access.** `/api/ag/admin/*` and the `/avatar/admin` page
sit behind an Access application that allows only your email. The admin
function also verifies the `Cf-Access-Jwt-Assertion` JWT (RS256, against
`https://<team>/cdn-cgi/access/certs`, checking audience, issuer and expiry),
refuses every request when `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, and
requires writes to come from the site's own origin. There is no admin password
in the codebase.

Alternatives considered and left for later: passkeys, OAuth (GitHub or
Discord) as "sign in to make your likes count", and email magic links (not
recommended: stores addresses).

## 5. Moderation

New entries are published at once (`AUTO_PUBLISH`), since validation already
rules out almost all bad content.

- Any key can report an entry once. At `REPORT_HIDE_THRESHOLD` reports
  (default 3) it is hidden until you review it.
- The admin page lists reported, hidden or all entries, each with its
  submitter's public ID, likes and reports. Actions:
  - **hide / unhide.** Unhiding marks the entry reviewed, so the same reports
    can't hide it again.
  - **delete.** Removes the entry with its likes and reports in one batch,
    after a confirm. It can't be undone, and the same (avatar, 'Mech) can be
    submitted again, so for repeat offenders ban instead.
  - **ban owner.** Bans the submitter's key: all its entries are hidden, its
    likes and reports are removed and the counts recomputed, and the key gets
    "banned" on every further call.
  - **fix 'Mech.** Corrects a unit's name or image URL (linked entries only).
- Setting `AUTO_PUBLISH=false` makes new entries start hidden until you unhide
  them.

## 5a. Settings

Tunable numbers are Pages environment variables. Defaults live in
`functions/api/ag/_lib/config.ts`; override them in the Cloudflare dashboard
(Workers & Pages → the project → Settings → Variables and Secrets). A change
takes effect on the next deployment. A missing or malformed value falls back
to the default. The admin page header shows the values in effect.

The repo has no `wrangler.toml` at its root on purpose: once a Pages project
has one, it becomes the source of truth for bindings and variables, and the
dashboard settings stop applying.

| variable | default | meaning |
|---|---|---|
| `REPORT_HIDE_THRESHOLD` | `3` | reports that auto-hide an entry; `0` turns auto-hide off |
| `AUTO_PUBLISH` | `true` | `false` makes new entries start hidden |
| `SUBMITS_PER_DAY` | `10` | submissions per key and per IP per day |
| `VOTES_PER_DAY` | `200` | likes per key and per IP per day |
| `REPORTS_PER_DAY` | `20` | reports per key and per IP per day |
| `KEYS_PER_DAY` | `5` | device keys minted per IP per day |
| `PAGE_SIZE` | `48` | entries per gallery page |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAFZV3_ri2orug_FJ` | public Turnstile site key, served by `GET /api/ag/config` |
| `ACCESS_TEAM_DOMAIN` | none | Zero Trust team domain, e.g. `stoneworks.cloudflareaccess.com` |
| `ACCESS_AUD` | none | AUD tag of the admin Access application |

Secrets go in the same screen as encrypted values, never in the repo:
`TURNSTILE_SECRET` (the widget's secret key) and `IP_HASH_SALT` (any long
random string; it salts the IP hashes in `ag_rate`).

## 6. Data model (D1)

The schema is `migrations/ag/0001_gallery.sql`. Every table and index is
prefixed `ag_`, so the gallery can share a D1 database with other features.

| table | holds |
|---|---|
| `ag_units` | `slug` (PK), `name`, `image` (MUL URL or NULL), `fetched` (when MUL was read; NULL if it failed) |
| `ag_avatars` | `id`, `q` (canonical query), `unit` (slug, or NULL for no 'Mech), `owner` (key hash), `votes`, `reports`, `hidden`, `reviewed`, `created` |
| `ag_keys` | `hash` (PK, SHA-256 of the key), `pid` (public ID), `created`, `banned` |
| `ag_votes` | `(avatar, voter)` pairs, one like per key per entry |
| `ag_reports` | `(avatar, voter)` pairs, one report per key per entry |
| `ag_rate` | `(who, action, day)` counters; `who` is a key hash or salted IP hash |

- `UNIQUE (q, unit)` merges duplicate submissions for the same 'Mech. SQLite
  treats NULLs as distinct there, so the partial unique index
  `ag_avatars_unlinked` on `q WHERE unit IS NULL` does the same for avatars
  with no 'Mech.
- `votes` and `reports` are counts kept on `ag_avatars`, recomputed in the
  same D1 batch that changes `ag_votes` or `ag_reports`.
- `reviewed` is set when you unhide an entry, so reports stop auto-hiding it.
- IPs are only ever stored as a salted hash inside `ag_rate`. Pages Functions
  have no cron, so about one rate check in fifty prunes counters older than
  the last few days.
- Indexes cover the gallery's reads: by unit, top, new, by owner, and likes by
  voter.

## 7. Pages

**Avatar creator (`/avatar`).** A static page with no gallery code. Its
second row of actions has **submit to gallery**, a plain link to
`gallery.html?submit&head=…` that carries the current avatar in the same
params as the creator's own URL (plus `lang` when the address bar has it), and
**gallery**.

**Gallery (`/gallery`, `web/gallery.html`).**
- Header: "you: 7Hq3xKpa · my avatars · move key", or "you: guest · use a
  key" before this browser has a key; EN / 한국어 switch.
- Tabs: **top**, **new**, **by 'Mech** (a card per 'Mech with its top avatar
  and count, ending with a "no 'Mech" group card; search by name), and **no
  'Mech** (`?unit=none`).
- Cards: the avatar (links to its entry page), the 'Mech name (or "no 'Mech"
  in dim italics), "by 7Hq3xKpa" ("by you" on your own), and the like toggle
  `♡ like · 12` / `♥ liked · 12`.
- `?unit=<slug>`: one 'Mech's MUL image, its "view on Master Unit List" link
  and all its avatars.
- `?id=<n>`: one entry. The avatar large, the 'Mech name, submitter, MUL image
  and link, like, "open in creator", report, delete (yours only), and the
  other avatars for the same 'Mech. An unlinked entry shows "no 'Mech" with no
  image, and the other unlinked avatars below.
- `?mine=1`: the avatars you submitted from this browser.
- `?submit&head=…`: opens the **Submit** panel, a modal over the dimmed
  gallery. It shows the avatar preview, an optional MUL URL field, "submitting
  as 7Hq3xKpa", the Turnstile check when Cloudflare asks for one, submit,
  close, and "← edit in creator" back to `/avatar` with the same parts.
  Any successful submission closes the panel and shows the avatar under a
  notice line: a new, published avatar switches to **new**, where it is the
  first card, marked and focused; one awaiting approval, or a duplicate
  ("already in the gallery"), opens its `?id=` page. A hidden entry's page
  reads "this avatar is under review". Errors keep the panel open.
  A missing or invalid avatar shows only the error, "edit in creator" and
  close. Closing removes the panel's params from the URL.
- Key panel: "move key" (or "use a key") next to your ID, or a
  `#key=…` link, opens it over the dimmed gallery (§4).

Strings go through `web/avatar/gallery.i18n.ts` (en/ko).

**Admin (`/avatar/admin`).** `web/gallery-admin.html`, copied to
`dist/web/avatar/admin.html` so it is served at the path Access guards
(`_headers` adds `noindex` and `no-store`). English only. Actions as in §5.

**Not found.** `web/404.html` at the site root makes unknown paths return a
404 page instead of Pages' fallback to `index.html`.

## 8. Files

| file | what |
|---|---|
| `migrations/ag/0001_gallery.sql` | schema (§6) |
| `migrations/ag/wrangler.local.toml` | local development only: where `d1 execute --local` finds the database |
| `functions/api/ag/config.ts` | public settings for the pages |
| `functions/api/ag/keys.ts` | mint a device key (Turnstile) |
| `functions/api/ag/avatars/index.ts` | list, submit |
| `functions/api/ag/avatars/[id].ts` | one entry; owner delete |
| `functions/api/ag/avatars/[id]/vote.ts`, `report.ts` | like toggle, report |
| `functions/api/ag/units.ts` | 'Mechs with entries |
| `functions/api/ag/admin/[[path]].ts` | admin routes |
| `functions/api/ag/_lib/` | `cf.ts` (hand-written D1/Pages types), `config.ts` (§5a), `http.ts`, `auth.ts` (device keys, IP hash), `rate.ts`, `turnstile.ts`, `mul.ts` (MUL fetch and parsing), `access.ts` (Access JWT check), `gallery.ts` (queries) |
| `web/avatar/avatar.gallery.ts` | shared by pages and functions: avatar validation and canonical form, MUL URL parsing, slug prettifier, public IDs |
| `web/avatar/avatar.compose.ts` | avatar box drawing, shared by the creator, the gallery and the server |
| `web/avatar/gallery.client.ts` | browser API client: device key, public ID, Turnstile |
| `web/avatar/gallery.i18n.ts` | gallery strings (en/ko) |
| `web/gallery.html`, `web/gallery.css`, `web/avatar/gallery.ts` | gallery page |
| `web/avatar/gallery.submit.ts` | the Submit panel |
| `web/avatar/gallery.key.ts` | the key panel: copy this browser's key, use one from another |
| `web/gallery-admin.html`, `web/avatar/gallery.admin.ts` | admin page |
| `web/avatar.html`, `web/avatar/avatar.ts` | creator: static "submit to gallery" and "gallery" links |
| `scripts/build-web.mjs`, `scripts/dist-web.mjs` | bundle and ship the gallery pages |
| `tests/gallery.test.ts` | validation, canonical form, MUL URL and page parsing, public IDs |
| `tests/gallery-api.test.ts` | the API end to end over the real migration in `node:sqlite`, with Turnstile, MUL and Access stubbed |

## 9. Setup in the Cloudflare dashboard

1. Create a D1 database and bind it to the Pages project as `DB`.
2. Create a Turnstile widget for `bt10x.stoneworks.dev` (Managed mode). Its
   site key `0x4AAAAAAFZV3_ri2orug_FJ` is already the default of
   `TURNSTILE_SITE_KEY`. Add its secret key as the encrypted secret
   `TURNSTILE_SECRET` (Production and Preview).
3. Add `IP_HASH_SALT` as an encrypted secret.
4. Add a Cloudflare Access application for `/api/ag/admin/*` and
   `/avatar/admin*` allowing your email. Copy its Application Audience (AUD)
   tag into `ACCESS_AUD` and the team domain (`<team>.cloudflareaccess.com`)
   into `ACCESS_TEAM_DOMAIN`, both as plain variables. `*.pages.dev` preview
   URLs, which Access does not cover, fail closed.
5. Create the tables once, from the repo root, signed in with
   `npx wrangler login`:
   `npx wrangler d1 execute <database-name> --remote --file=migrations/ag/0001_gallery.sql`.
   The statements use `IF NOT EXISTS`, so running it again is harmless, but it
   does not alter tables that already exist.
6. Deploy.

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

`--d1 DB=ag-local` gives `pages dev` the same database that
`wrangler.local.toml` points `d1 execute` at. Keep any `wrangler.toml` out of
the repo root (§5a). Submitting fetches the MUL page for real, so it needs
network. Admin routes refuse locally, since Access only runs on the real
domain. To start over, or after a schema change, delete `.wrangler/state` and
repeat step 3.

## 10. Later

- A 'Mech name search in the Submit panel instead of pasting MUL URLs, backed
  by MUL's unit index if one can be found, or by the repo's `docs/mtf` catalog.
  The stored slug stays the same.
- Settings editable from the admin page without redeploying (a one-row
  `ag_settings` table).
- If like manipulation shows up: OAuth sign-in, with anonymous likes weighted
  or filtered.
