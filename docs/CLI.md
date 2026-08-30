# CLI.md — btlib10x Terminal Web App

Single-page web application exposing the btlib10x core through a stripped-down
terminal emulator UI. Vanilla TypeScript + DOM only; zero runtime dependencies
(honors AGENTS.md). Bundled with esbuild (dev-only).

## Prompt

    {game_state}[:sub_state] >

- `game_state`: `setup` | `turn` | `over`
- `sub_state` (only during `turn`): `(N):move(team T, mech ID)` during engine
  phase `movement`, `(N):attack(team T, mech ID)` during `weaponAttack` —
  N is the turn number; team and id come from `nextActor(state)`.
- Phases auto-advance when every living unit has acted. After attacks resolve,
  `checkVictory()` decides: more teams alive → next turn (auto initiative roll),
  otherwise → `over`.

Examples:

    setup >
    turn(1):move(team 1, mech cicada) >
    turn(1):attack(team 0, mech hunchy) >
    over >

## Conventions

- All hex coordinates typed by the user are **1-based** (cols 1..width,
  rows 1..height), matching printed mapsheet labels and map JSON. Converted to
  engine coords internally.
- Dice flow through a mulberry32-backed `{ d6() }` Rng, default seed 42;
  `seed <n>` changes it at any time. Same seed ⇒ identical battle replay.
- Errors print as `error: <engine message>`. Failed commits leave state
  unchanged (the session rolls back via a serializable snapshot; buffers stay
  editable).
- `help` / `?` lists only commands legal in the current state.

## Commands

### Global (any state)

| command | effect |
|---|---|
| `help` / `?` | state hint line, then commands available now; `help <command>` shows usage plus per-argument explanations |
| `lang [<locale>]` | show or switch output language (`en`, `kr`); session-scoped, survives reset/rematch, defaults to `en` |
| `board` | ASCII grid (styled spans from `battleModel`), sized from loaded map's width×height (unit/terrain extent before a map is loaded); with no map and empty roster, explains how to load one. Rendered as styled spans in a `.board` block: terrain glyphs on the grid rows and team-colored unit ids (id characters only, via `cellStyles`); font family, size and line spacing come from the `--font-board` / `--board-fs` / `--board-lh` CSS variables and each terrain's scheme from the `--t-*` variables in `web/index.html` |
| `clear` | clear the scrollback screen |
| `log [n]` | last n events (default 10) |
| `info mech` | list available 'Mechs |
| `info mech <model>` | sheet summary: walk/run/jump ratings and weapons |
| `info map` | list available maps |
| `info map <name>` | map info: width×height, terrain types and counts, ASCII map with terrain glyphs |
| `seed <n>` | set RNG seed |
| `reset` | wipe everything back to empty setup |
| `autoplay` | hidden demo driver (not listed by `help`): resets nothing itself but expects a blank slate — run `reset` first. Prints a notice, then every 2s (`AUTOPLAY_INTERVAL_MS` in `web/autoplay.ts`) types the next command a demonstrator would: loads `quickstart`, places HBK-4G vs CDA-3MA adjacent, starts, then walks in place and fires every working weapon each turn until victory. Any manually typed command cancels it; it prints `autoplay finished.` when the battle ends |

### setup

| command | effect |
|---|---|
| `map <name>` | load rulebook map (`beginner`, `quickstart`) as terrain |
| `add <id> <model> <team> <gunnery> <col> <row> [facing]` | place unit (facing default `n`) |
| `rm <id>` | remove placed unit |
| `status` | setup summary: 'Mechs grouped by team, selected map name |
| `start` | ≥2 units on ≥2 teams required; creates battle, rolls initiative → `turn` |

### turn(N):move(team T, mech <id>)

The prompt names the acting unit; commands act on that 'Mech.

| command | effect |
|---|---|
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first); for walk/run/jump, renders a clipped ASCII hex map of the reachable hexes — exactly the smallest bounding box around every reachable hex, clamped to the board (no padding). Reachable hexes draw a team-colored `<>` in the belly; every reachable (hex, facing) edge is tinted with the acting unit's team color, and no facing arrows are drawn. Other units inside the crop keep their ids (team-colored) but no facing arrow. Movement paths (the `F`/`B`/`R`/`L` fragment sequence per landing) remain available programmatically via `reachableLandings`/`RevealedLanding.path` for later use, but are not rendered on the map |
| `move <col> <row>` | queue step into adjacent hex (forward/backward vs facing; jump = any adjacent) |
| `face <facing>` or `face <±1..5>` | queue facing change (`face ne`, `face -2`) |
| `sheet [id]` | with id: armor diagram + weapons for a unit; without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `done` | commit via `executeMove`; prints path + MP spent and total budget |

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `weapons [id]` | list weapon mounts: 1-based number, name, location, S/M/L, ammo, jammed/destroyed |
| `fire <targetId> <weapon> [<weapon> ...]` | queue weapon declarations using 1-based weapon numbers (target first; declare several weapons at once, all against the one shared target; rapid-fire SRM/LRM fire a full volley — no `shots` argument) |
| `sheet [id]` | with id: armor diagram + weapons for a unit; without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `done` | `declareAttacks` + `resolveDeclaredAttacks`; prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

### over

| command | effect |
|---|---|
| `sheet [id]` | with id: armor diagram + weapons for a unit; without id: brief unit list (id, model, position+facing) grouped by team |
| `rematch` | new battle, same roster + terrain + seed |
| globals | `board`, `log` remain available; `reset` returns to empty setup |

## Status — Classic BattleTech rule coverage

The engine implements a **subset of classic BattleTech game rules** for
**bipedal 'Mechs only**. The terminal app exposes everything the engine can
simulate. See `TODO.md` for the roadmap toward a fuller ruleset.

### Implemented

- **Units** — bipedal 'Mechs only (six record-sheet 'Mechs in `data/mechs/`).
  Front and rear armor are separate pools; internal structure is derived from
  tonnage on the standard TW table.
- **Movement** — walk, run, jump, standstill. MP costs include the base 1 MP
  to enter a hex plus a terrain surcharge (lightWoods +1, heavyWoods +2),
  +1 MP per level of elevation climbed (descent is free), and 1 MP per
  hexside of facing change. Ground moves step straight ahead or back; run
  cannot move backward; ground moves cannot climb more than one level per
  step. Jump steps into any adjacent hex at 1 MP per step, with the
  landing facing chosen freely; jump ignores elevation.
- **Line of sight** — intervening-hex line trace; light/heavy woods points
  (1/2) accumulate along the line and ≥ 3 points block. A real-valued
  "ray height" is drawn between attacker and target LOS levels (hex
  level + 1 for a bipedal 'Mech); an intervening hex blocks when its own
  LOS level meets or exceeds the ray's height at the hex's center.
- **To-hit (GATOR)** — gunnery + attacker movement + target movement + range
  bracket + intervening terrain + pulse + height difference; auto-hit ≤
  2, auto-miss > 12. Height difference: `−(attackerLevel − targetLevel)`
  (attacker higher = easier, lower = harder).
- **Hit location** — bipedal front / left side / right side / rear tables.
- **Cluster hits** — missile 2/5/6/10/15 + shot columns 2/3/4.
- **Damage** — front/rear armor transfer inward on depletion; side-torso
  internal-structure loss blows off the arm; head/CT IS death kills; leg IS
  death immobilizes. Hits on already-destroyed locations transfer.
- **Firing arc** — front arc only. (Side / rear arc classification is
  implemented in `arcs.ts` but is not yet wired into targeting.)
- **Weapons** — ballistic / energy / missile with short/medium/long range
  brackets, rapid-fire, pulse (−2 to-hit), ammo tracking, jam on natural 2
  (multi-shot), LRM lots-of-5 grouping.
- **Battle flow** — initiative roll, sequential movement phase, weapon
  attack phase, end-phase kill sweep, victory check, rematch.

### Not yet implemented

- **Heat** — heat scale, overheat effects, shutdown, ammo explosion.
- **Physical attacks** — punch, kick, charge, DFA.
- **Piloting rolls** — falling, standing up, leg/gyro damage effects.
- **Elevation** — hex height differences, height-based modifiers.
- **Side / rear firing arcs and torso twist** — classification code exists
  but is dormant.
- **Quadripedal 'Mechs**, vehicles, infantry, battle armor.
- **Critical hits** beyond the location-destroyed model (engine, gyro,
  sensor destruction).
- **Called shots**, aimed shots, spotter / indirect fire, ECM.
- **Pilot abilities** (edge, etc.), quirks, experience beyond the gunnery
  skill band.

### Verify-later

- LOS edge-graze tie-break uses deterministic cube rounding.

## Architecture

    web/index.html      terminal chrome: scrollback <pre>, prompt line, key capture, inline CSS
    web/main.ts         bootstrap; wires DOM ↔ session/cli; reprints prompt after each command
    web/cli.ts          tokenizer + per-state command registry + help generator
    web/session.ts      app-level state machine over the in-place BattleState:
                        setup roster, move-step & attack-decl buffers,
                        derived {setup|turn|over} + sub-state,
                        auto advancePhase / initiative roll / victory check
    web/rng.ts          mulberry32-seeded Rng
    web/format.ts       board, event-log, info/status and record-sheet/resolution formatters
    scripts/build-web.mjs  esbuild bundle: web/main.ts → web/app.js (inlines mech/map JSON)

Import wrinkle: tsc-emitted `.json` imports are not loadable by browsers, so the
app ships as an esbuild single-file bundle instead of consuming `dist/` directly.
Library sources stay untouched.

## Build & run

    npm install            # picks up esbuild devDependency
    npm run build:web      # single-shot: node scripts/build-web.mjs → web/app.js
    npm run dev:web        # watch + serve: rebuilds on change, serves at http://127.0.0.1:8000/web/index.html
    # custom port:  node scripts/build-web.mjs --watch --serve --port=3000
    # open http://localhost:8000

## Todo

1. [x] Write CLI.md (this doc)
2. [x] Add esbuild devDep, `build:web` script, AGENTS.md dev-deps note
3. [x] `web/index.html` terminal shell (inline CSS)
4. [x] `web/rng.ts` seeded PRNG
5. [x] `web/session.ts` session state machine
6. [x] `web/format.ts` board/log/info/status/sheet/resolution formatters
7. [x] `web/cli.ts` parser + per-state registries + help
8. [x] Setup commands (`map/add/rm/status/start`) + `info`/`sheet` commands
9. [x] Movement commands (`mode/move/face/sheet/status/cancel/done`)
10. [x] Attack commands (`weapons/fire/sheet/status/cancel/done` + resolution printing)
11. [x] Turn auto-advance, victory → `over`, `rematch`
12. [x] Verify typecheck + tests green; smoke test via static server
