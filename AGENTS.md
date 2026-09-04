# btlib10x

TypeScript library encapsulating Classic BattleTech board game logic.

## Status

- Implements a **subset of classic BattleTech game rules**. The currently
  implemented subset is documented under "Status — Classic BattleTech rule
  coverage" in `docs/CLI.md`.
- Bipedal 'Mechs only. Heat, physical attacks, piloting rolls, and
  side/rear firing arcs are outside the current subset. Elevation IS
  implemented: per-hex `level` (default 0) on the map, with movement
  climb cost, jump ignoring elevation, LOS elevation ray, and the
  height-difference to-hit modifier.
- Terrain: 13 core-rulebook types, data-driven from `src/data/terrain.json`
  (move surcharge, screening value, target to-hit mod, partial-cover and
  targeting-restriction flags). Water depth 2+ (water2/water3) blocks LOS
  in/out; water1 grants a −1 target modifier. Buildings carry a structural
  factor and collapse to rubble when depleted. Still deferred: basements,
  hull-down, multi-floor interiors, water depth-change movement cost, and
  partial-cover attack resolution (with piloting).
- Damage model: each location holds a flat armor HP number; overflow transfers inward **only after** a location's armor is fully depleted (no per-dot tracking).

## Commands

- `npm test` — run test suite once (vitest)
- `npm run test:watch` — watch mode
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — Biome check (lint + format + import order) over `src/`, `tests/`, `scripts/`, `web/` (generated `web/app.js` excluded)
- `npm run lint:fix` — same, applying safe+unsafe fixes (formatting, unused imports/params, literal keys)
- `npm run build` — emit ESM + declarations to `dist/`
- `npm run build:web` — bundle the `web/` terminal app with esbuild → `web/app.js`
- `npm run dev:web` — same but watch mode (rebuilds `web/app.js` on every source change)

Run lint + typecheck + tests together before considering work done: `npm run lint && npm run typecheck && npm test`.

## Layout

- `src/core/` — hex geometry (odd-q column-offset coords, flat-top hexes, cube-math line tracing), dice (injectable RNG), terrain, shared types
- `src/data/` — weapon catalog, `MechDef` schema + hand-rolled validator, `mechs/*.json`
- `src/rules/` — pure rule functions: movement, LOS, GATOR to-hit, hit location, cluster hits, damage, attack orchestration, battle state machine
- `tests/` — vitest suites; several assert against worked examples printed in the PDFs
- `web/` — single-page terminal emulator app over the core (see `docs/CLI.md`)

## Conventions & constraints

- Browser-first: **no Node-only APIs in `src/`** (dev scripts exempt).
- **Zero runtime dependencies**; dev deps are typescript + vitest + esbuild + biome (esbuild bundles the `web/` app, Biome lints/formats).
- Scratch/debug scripts and other temporary files live in `./tmp/` (gitignored), never the OS `/tmp`.
- Strictest sensible tsc settings (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- All randomness flows through an injected `Rng`; rules functions are deterministic given inputs — guaranteed by in-place mutation of a single serializable battle state (see `src/rules/game.ts`).
- Game state is plain serializable data; it is mutated **in place** through `src/rules/game.ts` APIs only. The engine is single-threaded and non-concurrent: rule functions mutate the passed `BattleState` directly and return `void`. Atomicity is guaranteed at the caller's commit boundary (the `web/session.ts` `commitAtomic` rollback), not per rule call.
- Web-layer user-facing strings go through the i18n catalogs (`web/i18n/*.ts`, locales `en` + `kr`); `en` is canonical — other locales are compile-checked against it, and new strings default to English until translated. Engine output in `src/` stays English.
- Board styling travels as structured spans beside the text (`render.ts` models + `boardToSpans`), never inline escape codes; the web layer maps styles to CSS classes (palette vars in `web/index.html`). Flat-text renderers stay byte-identical to their historic output.
- Mech data lives in `data/mechs/*.json` (copied into published package); new 'Mechs must pass `validateMechDef`.

## Roadmap

See `docs/TODO.md`. Later: sarna.net scraping (dev-only), full-intro rules expansion.
