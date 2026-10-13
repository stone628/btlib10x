# Using btlib10x

A walkthrough of one full battle turn: build the engine state, load a map,
create two 'Mechs, move, shoot, and check for victory. Every name below is
on the public surface listed in `docs/API.md`. If you don't see a helper in
that file, it's engine-internal — import from its source module instead.

```ts
import {
  loadCatalog,
  ensureMechRegistered,
  createBattle,
  rollInitiativePhase,
  executeMove,
  advancePhase,
  declareAttacks,
  resolveAllAttacks,
  nextActor,
  gameLoop,
  requireUnit,
  type BattleState,
  type GameEvent,
  type Rng,
} from "btlib10x";
```

All coordinates are **1-based** — hex columns, rows, and positions match the
printed mapsheet labels (`cols 1..`, `rows 1..`); there is no 0-based offset.

## 1. Provide an RNG

Every dice roll flows through an injected `Rng`, so battles are reproducible.
For a real game use any seeded generator; here is a minimal one:

```ts
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    d6() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 6) + 1;
    },
  };
}
const rng = mulberry32(42);
```

For tests you can also script exact die results (see `tests/helpers.ts`
`scriptedRng`).

## 2. Load the catalog, terrain, and the 'Mechs

'Mech sheets and maps ship as one packed catalog, `data/btlib10x.jsonl`
(published with the package; built by `npm run pack`). Load it once, then
register the sheets you need — nothing is registered until you ask:

```ts
import { readFileSync } from "node:fs";   // browsers fetch() the text instead
loadCatalog(readFileSync("node_modules/btlib10x/data/btlib10x.jsonl", "utf8"));
ensureMechRegistered("WVR-6R");
ensureMechRegistered("GRF-1N");
```

Terrain is plain data: a list of hex definitions `{ col, row, type, level? }`
whose missing hexes are clear ground at level 0. The engine supports 13
core-rulebook terrain types (`clear`, lightWoods, heavyWoods, rough, rubble,
pavement, water1, water2, water3, and light/medium/heavy/hardened buildings),
each with data-driven movement-cost, LOS-screening, and to-hit modifiers in
`src/data/terrain.data.ts` (read with `terrainMoveCost`, `costToEnter`,
`screeningPoints`, `terrainTargetMod`, `hasPartialCover`, `blocksTargeting`).
Give a building hex a preceding terrain entry and it is initialized with a
structural factor in `BattleState.buildings`; collapse to rubble happens when
the CF is depleted.

'Mech models reference the bundled record sheets — look a registered one up
with `mechDef(model)` or `mechDefFor({ model })`, list the registered ones with
`registeredMechDefs()` and every catalog entry with `catalogMechs()`. Bundled:
AS7-D (Atlas), BSW-X1, BZK-F3, CDA-3MA (Cicada), CN9-YLW2 (Centurion),
ENF-4R (Enforcer), GRF-1N (Griffin), HBK-4G (Hunchback), HCT-5S (Hatchetman),
HER-5SA (Hermes II), MC-MKII-2 (Mad Cat Mk II), TBR-Prime (Mad Cat),
WHK-Prime (Masakari), WVR-6R (Wolverine).

```ts
const state: BattleState = createBattle(
  {
    name: "example",
    width: 12,
    height: 9,
    terrain: [{ col: 7, row: 7, type: "lightWoods" }],
    legends: ["lightWoods"],
  },
  [
    { id: "wvr", model: "WVR-6R", team: 1, gunnery: 4, piloting: 5,
      position: { col: 3, row: 5 }, facing: "se" },       // facing southeast
    { id: "grf", model: "GRF-1N", team: 2, gunnery: 3, piloting: 5,
      position: { col: 11, row: 8 }, facing: "nw" },      // facing northwest
  ],
  { critsDisabled: false },
);
const events: GameEvent[] = [];   // every phase call appends its events here
```

`createBattle` initializes layered armor (front + rear), internal structure,
ammo, and crit-slot state from each `ResolvedMechDef`, validates ids, models,
and gunnery/piloting (0–7 each, at most 2 apart), and starts the battle in the
initiative phase of turn 1. `width`/`height` must cover every unit position and terrain hex (engine
coordinates are 1-based; the smallest valid board is 1×1). Pass
`critsDisabled: true` to suppress critical-hit resolution (useful when
scripting dice for a narrow damage scenario).

To load custom 'Mechs, hand `validateMechDef(JSON.parse(...))` your own
record-sheet JSON — anything invalid throws with every problem listed. New
record sheets are usually authored from a `.mtf` file (see `docs/MTF.md`).

## 3. Initiative phase

```ts
rollInitiativePhase(state, rng, events);   // 2D6 per team, ties reroll
// state.initiativeWinnerTeam === 1 -> team 1 moves/fires first this round
```

The loser's team acts first each phase (Total Warfare convention);
`nextActor(state)` tells you which unit should act next. `actorQueue(state)`
returns the same ordering split into `acted` (already moved/fired this phase)
and `pending` (in order), e.g. for a `status` display.

## 4. Movement phase

Declare a movement mode and walk the steps in a single `executeMove` call.
Each step either enters a hex or turns 1–5 hexsides. Costs: 1 MP per hex
entered plus a per-terrain surcharge (see `terrainMoveCost` / `costToEnter`
from the terrain catalog), +1 per level of elevation changed (up or down), 1
MP per hexside turned.

```ts
executeMove(state, "wvr", "run", [
  { kind: "enter", to: { col: 4, row: 5 } },       // forward (se)
  { kind: "turn", facings: 1 },                    // se -> s (1 MP)
  { kind: "enter", to: { col: 4, row: 6 } },       // forward (s)
  { kind: "turn", facings: -1 },                   // s -> se (1 MP)
], events);                                        // 4 MP spent
```

The engine enforces budgets, backward-step rules (no running backward, no
backward level change), a 2-level-per-hex forward climb cap, stacking (never
end on another 'Mech; pass through friends only), and jump rules (`GRF-1N` may
hop over anyone but land only on empty hexes; jump steps enter any adjacent
hex at 1 MP and ignore elevation, with the landing facing chosen freely).
Invalid plans throw with a reason instead of corrupting state.

```ts
executeMove(state, "grf", "walk", [], events);   // walk in place
```

Advance to shooting:

```ts
advancePhase(state, events);                 // movement -> attack
```

## 5. Weapon attack phase

Declare attacks per unit (one target per turn; ammo is spent at declaration).
Weapon indexes are **1-based** and match the model's mount order, e.g.
WVR-6R (Wolverine): `[1] Medium Laser (head), [2] SRM 6 (leftTorso),
[3] AC/5 (rightArm)`. The example below fires the Medium Laser.

```ts
declareAttacks(state, "wvr", [
  { weaponIndex: 1, targetId: "grf" },
], [], events);                      // weapon decls, physical decls, event sink
// Wolverine ML: gunnery 4 + ran +2 + target moved ~0 + light woods +1
//              + long range +4                              => TN 11
```

To fire a rapid-fire (R) weapon for its double tap, add `rapidFire: true` to
the declaration. Declaration validates per-weapon firing arc (TW p.105:
head/legs/torso weapons front-only, arm weapons front plus their own side,
rear-facing torso weapons rear-only), line of sight (woods points ≥3 or an
intervening elevation ridge blocks), range, ammo, jams, destroyed weapons,
and aborts declarations that would auto-miss (TN > 12). The attack direction
(TW p.119, side of the target struck) is classified from the target's facing
and recorded on the declaration; it drives the hit-location table and the
front/rear armor pool.

Resolve all declared attacks in one simultaneous sweep — TW resolves weapon
attacks simultaneously, so a 'Mech killed during the phase still fires its
declared shots (resolution order never depends on roster order):

```ts
resolveAllAttacks(state, rng, events);   // rolls to-hit + location(s) + crits for every unit

const grf = requireUnit(state, "grf");
grf.damage.armor.leftTorso;   // front armor, e.g. 18 - 5 = 13 after an ML hit
grf.damage.internalStructure; // derived from tonnage
```

Each resolution lands in your event sink as an `attackResolved` event carrying
the full breakdown (to-hit roll, cluster roll, hit groups, damage application,
critical hits). Events are transient — appended to the array you pass, never
stored on the state — so snapshots stay small. If you need a per-target suggestion before declaring,
`suggestFireTargets(state, unitId)` returns a `FireSuggestion` with arc, LOS,
range, ammo, and prone-prop checks already applied.

Commit deaths and close the turn. Engine never declares winner —
world around it owns stop condition, passed as `GameLoopStopper`:

```ts
advancePhase(state, events);                 // attack -> end (kills committed)
// world-side victory check, e.g. test helper in tests/helpers.ts or
// checkSessionVictory in web/terminal/session.ts:
const aliveTeams = new Set(
  Object.values(state.units).filter((u) => u.removed === "not").map((u) => u.team),
);
if (aliveTeams.size > 1) {
  advancePhase(state, events);               // end -> initiative, next turn
}
```

## 6. Ending the battle

Engine simulates; caller decides finish. Define a stopper over
`BattleState` and feed it to `gameLoop(state, rng, stopper)` —
`gameLoop` returns `{ actorId; stopped }` (events go to the sink you pass) with no winner field.
`tests/helpers.ts` `checkVictory` shows minimal test-world version;
`web/terminal/session.ts` `checkSessionVictory` + `drive()` shows app version:

```ts
const r = gameLoop(state, rng, (s) => checkVictory(s).winnerTeam !== null, events);
if (r.stopped) console.log("battle over");
```

A 'Mech dies when its center torso (or head) internal structure is destroyed;
side-torso internal-structure loss blows off its arm, leg IS loss immobilizes
it. All of this is handled inside damage transfer — you never apply those
effects manually. Landing damage on internal structure also triggers critical
hit rolls (weapon/ammo destruction, limb blow-off, cockpit kill, movement
penalties) unless `critsDisabled` was set.

## Worked example

`tests/exampleGame.test.ts` plays exactly this scenario with fully scripted
dice and asserts every rulebook number along the way (Wolverine TN 11 on
turn 1, then a 10-turn duel where the Griffin loses its center torso). Use
it as the canonical end-to-end reference.

## API cheat sheet

| Step | Call |
| --- | --- |
| Load catalog | `loadCatalog(text)` → `ensureMechRegistered(model)` |
| Build battle | `createBattle(map, units, { critsDisabled })` |
| Roll initiative | `rollInitiativePhase(state, rng, sink)` |
| Move | `executeMove(state, unitId, mode, steps, sink)` |
| Suggest fire plan | `suggestFireTargets(state, unitId)` |
| Shoot | `declareAttacks(state, unitId, weaponDecls, physicalDecls, sink)` → `resolveAllAttacks(state, rng, sink)` |
| Advance | `advancePhase(state, sink)` |
| Who acts? | `nextActor(state)` |
| Done? | caller stopper fed to `gameLoop(state, rng, stopper, sink)` |

See `docs/API.md` for the complete reference; `scripts/check-public-api.mjs`
keeps this file in sync with the actual `dist/index.d.ts` exports.
