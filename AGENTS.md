# btlib10x

TypeScript library encapsulating Classic BattleTech board game logic.

## Status

- Implements the **quick-start rules** (`pdf/CBT-Quick-Start-Rules.pdf`, `pdf/Beginner-Box-Quick-Start-Rules.pdf`) — those PDFs are the source of truth; consult before changing mechanics.
- Bipedal 'Mechs only. No heat, physical attacks, piloting rolls, or elevation (not covered by quick-start rules).
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
- All randomness flows through an injected `Rng`; rules functions are deterministic given inputs — required for reproducible battles and future sim work.
- Game state is plain serializable data; mutations happen through `src/rules/game.ts` APIs only.
- Web-layer user-facing strings go through the i18n catalogs (`web/i18n/*.ts`, locales `en` + `kr`); `en` is canonical — other locales are compile-checked against it, and new strings default to English until translated. Engine output in `src/` stays English.
- Board styling travels as structured spans beside the text (`render.ts` models + `boardToSpans`), never inline escape codes; the web layer maps styles to CSS classes (palette vars in `web/index.html`). Flat-text renderers stay byte-identical to their historic output.
- Mech data lives in `data/mechs/*.json` (copied into published package); new 'Mechs must pass `validateMechDef`.

## Roadmap

See `TODO.md`. Later: sarna.net scraping (dev-only), full-intro rules expansion, 10x-granular continuous-time mode.
