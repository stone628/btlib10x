# btlib10x

TypeScript library encapsulating BattleTech Total Warfare board game logic.

## Status

- Implements a **subset of BattleTech Total Warfare rules**. The currently
  implemented subset is documented under "Status — BattleTech Total Warfare rule
  coverage" in `docs/CLI.md`.
- Bipedal 'Mechs only. Punch, kick, club, physical-weapon, charge and DFA
  attacks are implemented (no displacement of any kind, by design); the other
  physical-attack extras are not (see `docs/VISION.md`). Charge / DFA are
  declared by movement: ending a walk / run (charge) or jump (DFA) path in an
  enemy hex stops the unit in the hex before it and the attack resolves in the
  physical phase. Piloting rolls, falling/prone, pilot damage and
  consciousness are implemented, including the PSRs from charges and DFAs.
  Clubs need two working hands (both arms standing, hand actuators intact) to
  pick up, hold and swing; losing one drops the club, a shoulder hit only
  bars the swing.
  Firing arcs implemented per TW: four arcs (front / rear /
  left / right side), per-weapon mounting arcs (head/legs/torso front-only,
  arms add own side, `rearFacing` torso mounts rear-only), attack
  direction resolved target-side (drives hit-location column + front/rear
  armor pool), and torso twist (`torso` command; shifts the attacker's
  effective facing one hexside). Elevation IS
  implemented: per-hex `level` (default 0) on the map, with movement
  climb cost, jump ignoring elevation, and LOS elevation ray.
- Terrain: 12 core-rulebook types, data-driven from `src/data/terrain.data.ts`
  (move surcharge, screening value, target to-hit mod, partial-cover and
  targeting-restriction flags). Water depth 2+ (water2/water3) blocks LOS
  in/out; water1 grants partial cover. Buildings carry a structural
  factor and collapse to rubble when depleted. Still deferred: basements,
  hull-down, multi-floor interiors, hull breach and underwater weapons.
  Water movement is modeled: a water hex has a surface at its level and a
  bed `depth` levels below, level changes cost 1 MP per level (max 2 per
  hex), running into water is banned (Minimum Movement excepted), and jumps
  obey TW p.53.
- Hulls and wreckage: a 'Mech whose pilot ejects, dies or abandons it
  (`mode abandon`, house rule) stays on the board as a neutral, targetable,
  passable hull (TO:AR pp.184-185); a destroyed 'Mech of 40 t+ leaves Rough
  wreckage (+1 MP, TO:AR p.155) after the TW p.128 salvage fall.
  `salvageReport` lists both. Rules and rationale: `docs/VISION.md` §2.1, §2.4.
- Scoring: `scoreReport(state)` gives each team's TW p.257 Battle Value score
  at any moment, from MUL BV (`MechDef.bv`, MTF `BV:` header), the skill
  multiplier, crippling damage and partial damage. Design: `docs/SCORING.md`.
- Heat-causing weapons (TW pp.113, 139, 159, 303): flamers deal heat instead
  of damage under the per-unit `UnitPolicy.heatFlamer` (default on); Plasma
  Rifle adds 1D6 heat, Plasma Cannon deals 2D6 heat only. Outside heat lands
  in the heat phase, capped at 15 per turn. Fire/smoke and infernos deferred.
- Anti-missile systems (TW pp.129-130): AMS and Laser AMS (`WeaponDef.antiMissile`
  `"ammo"` | `"laser"`) engage one hitting missile attack per turn in their arc,
  −4 on the Cluster roll (Streak counts as 11); the defender's
  `UnitPolicy.amsPolicy` (`expected` default, `firstHit`, `priority`, `off`)
  picks which. Logic in `src/rules/ams.ts`, wiring in `resolveAllAttacks`.
- Damage model: each location holds a flat armor HP number; overflow transfers inward **only after** a location's armor is fully depleted (no per-dot tracking).
- Partial cover (TW): a target in a water1/building hex with the attacker not
  higher gains +1 to-hit and leg hit-location rolls strike the cover (dealt
  as a miss). Still deferred: cover-hit building-CF damage (with piloting).

## Commands

- `npm test` — selective run (`scripts/test-default.mjs`): tests affected by uncommitted changes, or by the last commit when the tree is clean; builds `dist/` first when `src/` changed; falls back to the full suite for catalog data edits or with no parent commit
- `npm run test:all` — full suite once (vitest)
- `npm run test:watch` — watch mode
- `npm run test:changed` — run only tests affected by git-changed files (iteration; accepts a compare ref, e.g. `npm run test:changed -- main`)
- `npm run test:related -- <files>` — run only tests importing the given source files (e.g. `npm run test:related -- src/rules/tohit.ts`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — Biome check (lint + format + import order) over `src/`, `tests/`, `scripts/`, `web/`, `data/` (generated web bundles excluded; `data/**/*.json` and `data/btlib10x.jsonl` untouched)
- `npm run lint:fix` — same, applying safe+unsafe fixes (formatting, unused imports/params, literal keys)
- `npm run build` — emit ESM + declarations to `dist/`
- `npm run pack` — pack `data/mechs/*.json` + `data/maps/*.json` → `data/btlib10x.jsonl` (base catalog artifact)
- `npm run pack:ia` — pack `web/instant/maps/*.json` → `web/instant/instant.jsonl` (Instant-Action-only maps; `build:web` copies it to `web/btlib10x.ia.jsonl` when present)
- `npm run pack:sw` — pack `docs/mtf/sw/json/*.json` → `docs/mtf/sw/sw.jsonl` (SW season pack artifact; `pack-catalog.mjs --exclude` can drop sheets the engine cannot model)
- `npm run build:web` — esbuild-bundle `src/index.ts` → `web/btlib10x.js` (engine; `scripts/build-dts.mjs` rolls its declarations into `web/btlib10x.d.ts`, so library users need only those two files) `web/terminal/terminal.ts` → `web/terminal.js` (terminal app; engine kept external), `web/instant/instant.ts` → `web/instant.js` (Instant Action; engine kept external) and `web/avatar/avatar.ts` → `web/avatar.js` (avatar creator), plus copy `data/btlib10x.jsonl` → `web/btlib10x.jsonl` and `docs/mtf/sw/sw.jsonl` → `web/btlib10x.sw.jsonl` (each pack keeps its own string table; both fetched once at boot, SW failure degrades with a warning)
- `npm run dev:web` — same but watch mode (rebuilds `web/btlib10x.js` + `web/terminal.js` + `web/avatar.js` on every source change; serves the landing page at `/index.html`)

**Stale-dist trap.** Anything importing `"btlib10x"` resolves through package `exports` to `dist/` — web sources typecheck against `dist/index.d.ts`, tests exercising `web/terminal/session.ts` run against `dist/index.js`, while rule tests import `src/` directly. After any engine change, run `npm run build` before lint/typecheck/test, or `web/` code and tests silently use a stale engine (real failure mode: identical `reachableLandings` inputs producing different move paths). `web/btlib10x.js` (the browser-runtime core bundle) rebuilds via `build:web`/`dev:web` and never reads `dist/`.

Run lint + typecheck + tests together before considering a change done: `npm run lint && npm run typecheck && npm test`. Run the full suite (`npm run test:all`, after `npm run build`) before pushing, and whenever `package.json`, the vitest config, `tests/setup.ts` or catalog data change.

**Filtered runs (iteration only).** `test:changed` / `test:related` select tests via the
static import graph, so they miss the catalog path: data edits (`data/mechs/*.json`,
`data/maps/*.json`) need `npm run pack`, SW edits (`docs/mtf/sw/json/*.json`) need
`npm run pack:sw`, and engine edits need `npm run build` first,
or session/web tests silently run against stale `dist/` + old `btlib10x.jsonl`.
Selection quirks (verified): files no test imports (e.g. `AGENTS.md`) select nothing
(exit 0, vacuously green); `package.json` / vitest-config edits select the whole suite;
anything reachable from `tests/setup.ts` (the vitest setup file, e.g. `src/data/catalog.ts`)
selects the whole suite; widely-imported engine modules fan out broadly
(`src/rules/tohit.ts` → 30 of 37 files, `src/rules/game/queries.ts` → 30), while
phase modules stay narrow (`game/move.ts` → 12, `game/declare.ts` → 17). Tests import
the module that defines each symbol, never the `src` barrel (Biome `noRestrictedImports`).
`npm test` and these filtered runs never replace `npm run test:all` before pushing.

## Versioning

The engine, bt10x terminal and Instant Action each carry their own build stamp
`YYMMDD-<8-char hash>` (UTC committer date): the last commit touching that
component's files, `-dirty` when they have uncommitted edits. Nothing is bumped
by hand; `package.json` `version` is unused. Watched paths are `STAMP_PATHS` in
`scripts/build-stamp.mjs` (engine: `src/` + catalog data; each app: its folder,
its root HTML/CSS and the shared web assets). `build-web.mjs` /
`standalone-web.mjs` inject them via esbuild `define` (`__BTLIB_VERSION__` →
`VERSION` in `src/version.ts`; `__APP_VERSION__` / `__ENGINE_BUILT_WITH__` →
`web/{terminal,instant}/version.ts`); unbundled runs see `dev`. Both top bars
show `v<app> · engine <engine>` and flag a cached engine that differs from the
one the app was built with. Path stamps need full history: a shallow clone
fails the build.

## Layout

- `src/core/` — hex geometry (odd-q column-offset coords, flat-top hexes, cube-math line tracing), dice (injectable RNG), terrain, shared types
- `src/data/` — engine side of catalogs: schemas, codecs, hand-rolled validators, lookup registries; weapons/ammo/terrain embedded here (catalog data needs engine attention, so it is not a separate bundle)
- `data/` — canonical base-catalog sources + packed artifact: `mechs/*.json`, `maps/*.json` (editable source of truth), `btlib10x.jsonl` (generated by `npm run pack`; line 0 is the manifest, see `docs/MTF.md`). SW season-pack sources live in `docs/mtf/sw/json/` (packed by `npm run pack:sw` → `docs/mtf/sw/sw.jsonl`)
- `src/rules/` — pure rule functions: movement, LOS, GATOR to-hit, hit location, cluster hits, damage, attack orchestration, battle state machine
  - `src/rules/game/` — the battle state machine, one module per concern (`types`, `constants`, `queries`, `turnOrder`, `consequences`, `move`, `declare`, `resolveAttacks`, `heatPhase`, `loop`, …); a module imports only modules below it (order in `docs/GAME_REFACTORING.md` §2), and `src/rules/**` never imports the `src/index` barrel
- `functions/` — Cloudflare Pages Functions (Pages requires this root folder). One prefix per sub-project: the avatar gallery owns `functions/api/ag/` (server code in its `_lib/`), `migrations/ag/` and D1 tables `ag_*`; a new backend takes its own prefix instead of adding to these. Types are hand-written (`functions/api/ag/_lib/cf.ts`), no wrangler dependency. See `docs/GALLERY.md` §2
- `tests/` — vitest suites; several assert against worked examples printed in the PDFs
  - One file per testing area (e.g. `movement`, `los`, `critical-effects`, `salvage`, `session`); add new tests to the matching area file, in a `describe` named for the fix ID or rule, instead of creating a new file per fix. Shared fixtures go in `tests/helpers/` (`rng`, `battle`, `piloting`, `session`; import the specific file)
- `web/` — static site: `index.html` landing page at `/` (EN/KO inline, `landing.css`), `terminal.html` + `web/terminal/` terminal emulator app over the core (see `docs/CLI.md`), `instant.html` + `web/instant/` Instant Action, a menu-driven battle app on the TUI kit and a vector hex map (see `docs/INSTANT.md`; it imports only `btlib10x` and `window.TUI`, never `web/terminal/`, and keeps its own i18n catalog in `web/instant/i18n/`), `avatar.html` + `web/avatar/` 'Mech avatar creator, `gallery.html` + `web/avatar/gallery*.ts` avatar gallery (see `docs/GALLERY.md`), `tui.css` + `tui.js` plain-JS TUI component kit with `tui-demo.html` (see `docs/TUI.md`). Served files (HTML, CSS, fonts, built bundles) stay at the `web/` root; TS sources live in the subfolders

## Conventions & constraints

- Browser-first: **no Node-only APIs in `src/`** (dev scripts exempt).
- **Zero runtime dependencies**; dev deps are typescript + vitest + esbuild + biome (esbuild bundles the `web/` app, Biome lints/formats).
- Scratch/debug scripts and other temporary files live in `./tmp/` (gitignored), never the OS `/tmp`.
- Strictest sensible tsc settings (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- All randomness flows through an injected `Rng`; rules functions are deterministic given inputs — guaranteed by in-place mutation of a single serializable battle state (see `src/rules/game/`).
- Game state is plain serializable data; it is mutated **in place** through `src/rules/game/*` APIs only. The engine is single-threaded and non-concurrent: rule functions mutate the passed `BattleState` directly and return `void`. Atomicity is guaranteed at the caller's commit boundary (the `web/terminal/session.ts` `commitAtomic` rollback), not per rule call.
- Web-layer user-facing strings go through the i18n catalogs (`web/terminal/i18n/*.ts`, locales `en` + `ko`, with `kr` accepted as an alias of `ko`); `en` is canonical — other locales are compile-checked against it, and new strings default to English until translated. Engine output in `src/` stays English.
- Board styling travels as structured spans beside the text (`render.ts` models + `boardToSpans`), never inline escape codes; the web layer maps styles to CSS classes (palette vars in `web/bt10x.css`). Flat-text renderers stay byte-identical to their historic output.
- Mech data lives in `data/mechs/*.json` (copied into published package); new 'Mechs must pass `validateMechDef`.

## Rules reference

For any BattleTech rules question or TW-compliance check, use the `battletech-rules`
skill in `.agents/skills/battletech-rules/`: read its `SKILL.md`, then only the one routed
`references/` file. Do **not** read `TW_RULEBOOK.md` at the repo root (437 KB, ~115k
tokens). Cite pages as `TW p. N` (printed page = PDF page − 1).

## Roadmap

See `docs/VISION.md`. Later: sarna.net scraping (dev-only), full-intro rules expansion.
