# Using btlib10x

A walkthrough of one full battle turn: build the engine state, load a map,
create two 'Mechs, move, shoot, and check for victory. All imports come from
the package root:

```ts
import {
  createBattle, rollInitiativePhase, declareMove, executeMove,
  advancePhase, declareAttacks, resolveDeclaredAttacks,
  resolveAllAttacks, nextActor, checkVictory, getUnit,
  type BattleState, type Rng,
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

For tests you can also script exact die results (see `tests/helpers.ts`).

## 2. Load terrain and create the 'Mechs

Terrain is plain data: a list of hex definitions `{ col, row, type, level? }`
whose missing hexes are clear ground at level 0. The engine supports 13
core-rulebook terrain types (`clear`, lightWoods, heavyWoods, rough, rubble,
pavement, water1, water2, water3, and light/medium/heavy/hardened buildings),
each with data-driven movement-cost, LOS-screening, and to-hit modifiers in
`src/data/terrain.json`. Give a building hex a preceding terrain entry and it
is initialized with a structural factor (`BattleState.buildings`); collapse to
rubble happens when the CF is depleted. 'Mech models reference the
bundled record sheets (`MECH_DEFS`: AS7-D, CDA-3MA, ENF-4R, GRF-1N, HBK-4G,
HER-5SA, MC-MKII-2, TW-Prime, WHK-Prime, WVR-6R).

```ts
const state: BattleState = createBattle(
  [
    { id: "wvr", model: "WVR-6R", team: 0, gunnery: 4,
      position: { col: 3, row: 4 }, facing: "se" },       // facing southeast
    { id: "grf", model: "GRF-1N", team: 1, gunnery: 3,
      position: { col: 11, row: 8 }, facing: "nw" },      // facing northwest
  ],
  {
    terrain: [{ col: 7, row: 7, type: "lightWoods" }],
    width: 12,
    height: 9,
    critsDisabled: false,
  },
);
```

`createBattle` initializes layered armor (front + rear), internal structure,
ammo, and crit-slot state from each `ResolvedMechDef`, validates ids, models,
and gunnery (0–7), and starts the battle in the initiative phase of turn 1.
`width`/`height` must cover every unit position and terrain hex (engine
coordinates are 1-based; the smallest valid board is 1×1). Pass
`critsDisabled: true` to suppress critical-hit resolution (useful when
scripting dice for a narrow damage scenario).

To load custom 'Mechs, hand `validateMechDef(JSON.parse(...))` your own
record-sheet JSON — anything invalid throws with every problem listed. New
record sheets are usually authored from a `.mtf` file (see `docs/MTF.md`).

## 3. Initiative phase

```ts
rollInitiativePhase(state, rng);   // 2D6 per team, ties reroll
// state.initiativeWinnerTeam === 0 -> team 0 moves/fires first this round
```

The loser's team acts first each phase (Total Warfare convention);
`nextActor(state)` tells you which unit should act next. `actorQueue(state)`
returns the same ordering split into `acted` (already moved/fired this phase)
and `pending` (in order), e.g. for a `status` display.

## 4. Movement phase

Declare a movement mode, then execute steps. Each step either enters a hex or
turns 1–5 hexsides. Costs: 1 MP per hex entered plus a per-terrain surcharge
(lightWoods +1, heavyWoods +2, rough/rubble +1, water2/3 +3, buildings
+1/+2/+3/+4, pavement +0; data-driven from the terrain catalog), +1
per level climbed (descent free), 1 MP per hexside turned.

```ts
declareMove(state, "wvr", "run");                  // running budget: 8 MP
executeMove(state, "wvr", [
  { kind: "enter", to: { col: 4, row: 5 } },       // forward (se)
  { kind: "turn", facings: 1 },                    // se -> s (1 MP)
  { kind: "enter", to: { col: 4, row: 6 } },       // forward (s)
  { kind: "turn", facings: -1 },                   // s -> se (1 MP)
]);                                                // 4 MP spent
```

The engine enforces budgets, backward-step rules (no running backward), a 1-
level-per-step ground climb cap, stacking (never end on another 'Mech; pass
through friends only), and jump rules (`GRF-1N` may hop over anyone but land
only on empty hexes; jump steps enter any adjacent hex at 1 MP and ignore
elevation, with the landing facing chosen freely). Invalid plans throw with a
reason instead of corrupting state.

```ts
declareMove(state, "grf", "walk");
executeMove(state, "grf", []);               // walk in place
```

Advance to shooting:

```ts
advancePhase(state);                         // movement -> weaponAttack
```

## 5. Weapon attack phase

Declare attacks per unit (one target per turn; ammo is spent at declaration).
Weapon indexes are **1-based** and match the model's mount order, e.g. WVR-6R:
`[1] Medium Laser (head), [2] SRM 6 (LT), [3] AC/5 (RA)`.

```ts
declareAttacks(state, "wvr", [
  { weaponIndex: 1, targetId: "grf" },
]);
// Wolverine ML: gunnery 4 + ran +2 + target moved ~ + light woods +1
//              + long range +4                              => TN 11

declareAttacks(state, "grf", [
  { weaponIndex: 1, targetId: "wvr" },
]);
// Griffin PPC:  gunnery 3 + walked +1 + target moved ~
//              + long range +4 + light woods +1             => TN 9
```

To fire a rapid-fire (R) weapon for its double tap, add `rapidFire: true` to
the declaration. Declaration validates arc (front only), line of sight (woods
points ≥3 or an intervening elevation ridge blocks), range, ammo, jams,
destroyed weapons, and aborts declarations that would auto-miss (TN > 12).

Resolve in activation order — damage lands immediately on the target's layered
damage state, but destroyed 'Mechs keep firing until the phase ends:

```ts
resolveDeclaredAttacks(state, "wvr", rng);   // rolls to-hit + location(s) + crits
resolveDeclaredAttacks(state, "grf", rng);

const grf = getUnit(state, "grf");
grf.damage.armor.leftTorso;   // front armor, e.g. 18 - 5 = 13 after an ML hit
grf.damage.internalStructure; // derived from tonnage
```

Each resolution is appended to `state.events` as an `attackResolved` event
carrying the full breakdown (to-hit roll, cluster roll, hit groups, damage
application, critical hits) — enough to replay the entire battle. As an
alternative to driving each unit yourself, `resolveAllAttacks(state, rng)`
resolves every unit's declared attacks in one call.

Commit deaths and close the turn:

```ts
advancePhase(state);                         // weaponAttack -> end (kills committed)
if (!checkVictory(state).winnerTeam && !checkVictory(state).draw) {
  advancePhase(state);                       // end -> initiative, next turn
}
```

## 6. Ending the battle

```ts
const result = checkVictory(state);   // { winnerTeam: 0 | 1 | null, draw }
if (result.winnerTeam !== null) console.log(`Team ${result.winnerTeam} wins`);
```

A 'Mech dies when its center torso (or head) internal structure is destroyed;
side-torso internal-structure loss blows off its arm, leg IS loss immobilizes
it. All of this is handled inside damage transfer — you never apply those
effects manually. Landing damage on internal structure also triggers critical
hit rolls (weapon/ammo destruction, limb blow-off, cockpit kill, movement
penalties) unless `critsDisabled` was set.

## Worked example

`tests/exampleGame.test.ts` plays exactly this scenario with fully scripted
dice and asserts every rulebook number along the way (Wolverine TN 11 /
Griffin TN 9 on turn 1). Use it as the canonical end-to-end reference.

## API cheat sheet

| Step | Call |
| --- | --- |
| Build battle | `createBattle(units, { terrain, width, height, critsDisabled })` |
| Roll initiative | `rollInitiativePhase(state, rng)` |
| Move | `declareMove` → `executeMove` |
| Shoot | `declareAttacks` → `resolveDeclaredAttacks` (or `resolveAllAttacks`) |
| Advance | `advancePhase` |
| Who acts? | `nextActor(state)` |
| Done? | `checkVictory(state)` |

See `docs/API.md` for the complete reference.
