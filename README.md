# btlib10x

**btlib10x** is a zero-dependency TypeScript library that simulates a subset of
the BattleTech *Total Warfare* board game rules for bipedal 'Mechs: movement,
line of sight, to-hit, weapon and physical attacks, damage and criticals,
heat, piloting rolls and Battle Value scoring. It is deterministic given an
injected RNG and keeps the whole battle in one serializable `BattleState`.

The repository also holds single-page web apps built on the library. They are
proof-of-concept demos of how the engine plays, not a finished game:

- **bt10x terminal** (`web/terminal.html`) — a terminal-emulator UI that exposes
  everything the engine simulates through typed commands.
- **Instant Action** (`web/instant.html`) — a menu-driven "pick a lance, pick a
  map, drop" battle on a vector hex map.
- **Avatar creator and gallery** (`web/avatar.html`, `web/gallery.html`) — glyph
  'Mech avatars, with a small Cloudflare Pages backend for the gallery.
- **TUI kit** (`web/tui.js`, `web/tui.css`) — the plain-JS terminal-style
  component kit Instant Action is built on.

The live site is at <https://bt10x.stoneworks.dev>.

## Quick start

Requires Node.js 20 or newer.

```sh
npm install
npm run build        # library → dist/
npm run dev:web      # build the web apps and serve web/ at http://localhost:8012
```

Other common commands:

| Command | What it does |
| --- | --- |
| `npm test` | Tests affected by your changes (`npm run test:all` for the full suite) |
| `npm run lint` / `npm run typecheck` | Biome check / `tsc --noEmit` |
| `npm run build:web` | Bundle the engine and apps into `web/` |
| `npm run dist:web` | Build the deployable static site into `dist/web/` |
| `npm run dist:standalone` | Single-file terminal app at `dist/standalone/bt10x.html` |
| `npm run pack` | Pack `data/mechs` and `data/maps` into `data/btlib10x.jsonl` |

Run `npm run build` after engine changes: web code and session tests import
`btlib10x` through `dist/`. `AGENTS.md` has the full command list and caveats.

## Using the library

```ts
import { loadCatalog, createBattle, executeMove, declareAttacks, resolveAllAttacks } from "btlib10x";
```

See [docs/USAGE.md](docs/USAGE.md) for a full turn walkthrough and
[docs/API.md](docs/API.md) for the public surface. In the browser, the bundle
`web/btlib10x.js` with its types in `web/btlib10x.d.ts` is all you need.

## Layout

```
src/core/      hex geometry, dice, terrain, shared types
src/data/      catalog schemas, codecs, weapon/ammo/terrain data
src/rules/     pure rule functions; src/rules/game/ is the battle state machine
data/          'Mech and map sources (JSON) and the packed catalog
web/           static site: landing page, terminal, Instant Action, avatar, TUI kit
functions/     Cloudflare Pages Functions (avatar gallery API)
migrations/    D1 database migrations for the gallery
scripts/       build, pack and MTF import scripts
tests/         vitest suites
docs/          documentation
```

## Documentation

- [VISION.md](docs/VISION.md) — goals, rules principles and policy departures from TW
- [API.md](docs/API.md) — library public API; [USAGE.md](docs/USAGE.md) — usage walkthrough
- [CLI.md](docs/CLI.md) — terminal app and the rule coverage status
- [INSTANT.md](docs/INSTANT.md) — Instant Action app
- [TUI.md](docs/TUI.md) — TUI component kit
- [GALLERY.md](docs/GALLERY.md) — avatar gallery and its backend
- [TABLES.md](docs/TABLES.md), [SCORING.md](docs/SCORING.md), [MTF.md](docs/MTF.md),
  [REPLAY.md](docs/REPLAY.md), [PERSONA.md](docs/PERSONA.md) — reference tables, BV scoring, MTF record-sheet import, replay format (draft), persona AI player

## Legal

Unofficial fan project. It is not affiliated with, endorsed, sponsored or
approved by Catalyst Game Labs, The Topps Company, Inc. or Microsoft.

BattleTech, BattleMech, 'Mech and MechWarrior are trademarks or registered
trademarks of their respective owners. BattleTech is owned by The Topps
Company, Inc. and the tabletop game is published under license by Catalyst
Game Labs. 'Mech names and game data are used for reference only, and no
claim to them is made. Rules are referenced by page from *Total Warfare*;
buy the rulebook to play the full game.

The web app's font, Bt10x Mono, is a subset of JuliaMono by cormullion,
used under the SIL Open Font License 1.1 (see `web/fonts/OFL.txt`).
