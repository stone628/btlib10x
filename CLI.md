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
  unchanged (engine returns immutable clones; buffers stay editable).
- `help` / `?` lists only commands legal in the current state.

## Commands

### Global (any state)

| command | effect |
|---|---|
| `help` / `?` | list commands available now |
| `board` | ASCII grid (`renderBattle`), sized from loaded map's width×height (unit/terrain extent before a map is loaded) |
| `log [n]` | last n events (default 10) |
| `info mech` | list available 'Mechs |
| `info mech <model>` | sheet summary: walk/run/jump ratings and weapons |
| `info map` | list available maps |
| `info map <name>` | map info: width×height, terrain types and counts |
| `sheet <id>` | record sheet for unit `<id>`: armor per location, weapons with ammo/jam status |
| `seed <n>` | set RNG seed |
| `reset` | wipe everything back to empty setup |

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
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first) |
| `move <col> <row>` | queue step into adjacent hex (forward/backward vs facing; jump = any adjacent) |
| `face <facing>` or `face <±1..5>` | queue facing change (`face ne`, `face -2`) |
| `sheet` | record sheet of the acting 'Mech |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `done` | commit via `executeMove`; prints path + MP spent |

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `weapons [id]` | list weapon mounts: index, name, location, S/M/L, ammo, jammed/destroyed |
| `fire <weaponIndex> <targetId> [shots]` | queue declaration (one shared target per turn; rapid-fire may pass shots) |
| `sheet` | record sheet of the acting 'Mech |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `done` | `declareAttacks` + `resolveDeclaredAttacks`; prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

### over

| command | effect |
|---|---|
| `rematch` | new battle, same roster + terrain + seed |
| globals | `board`, `log` remain available; `reset` returns to empty setup |

## Architecture

    web/index.html      terminal chrome: scrollback <pre>, prompt line, key capture, inline CSS
    web/main.ts         bootstrap; wires DOM ↔ session/cli; reprints prompt after each command
    web/cli.ts          tokenizer + per-state command registry + help generator
    web/session.ts      app-level state machine around immutable BattleState:
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
    npm run build:web      # node scripts/build-web.mjs → web/app.js
    # serve statically, e.g.:  python3 -m http.server -d web 8080
    # open http://localhost:8080

## Todo

1. [ ] Write CLI.md (this doc)
2. [ ] Add esbuild devDep, `build:web` script, AGENTS.md dev-deps note
3. [ ] `web/index.html` terminal shell (inline CSS)
4. [ ] `web/rng.ts` seeded PRNG
5. [ ] `web/session.ts` session state machine
6. [ ] `web/format.ts` board/log/info/status/sheet/resolution formatters
7. [ ] `web/cli.ts` parser + per-state registries + help
8. [ ] Setup commands (`map/add/rm/status/start`) + `info`/`sheet` commands
9. [ ] Movement commands (`mode/move/face/sheet/status/cancel/done`)
10. [ ] Attack commands (`weapons/fire/sheet/status/cancel/done` + resolution printing)
11. [ ] Turn auto-advance, victory → `over`, `rematch`
12. [ ] Verify typecheck + tests green; smoke test via static server
