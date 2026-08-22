# Using btlib10x

A walkthrough of one full battle turn: build the engine state, load a map,
create two 'Mechs, move, shoot, and check for victory. All imports come from
the package root:

```ts
import {
  createBattle, rollInitiativePhase, declareMove, executeMove,
  declareAttacks, resolveDeclaredAttacks, advancePhase,
  nextActor, checkVictory, getUnit,
  type BattleState, type Rng,
} from "btlib10x";
```

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

## 2. Load the map and create the 'Mechs

Terrain is plain data: a list of hex definitions `{ col, row, type }` whose
missing hexes are clear ground. 'Mech models reference the bundled record
sheets (`MECH_DEFS`:
ENF-4R, HBK-4G, CDA-3MA, HER-5SA, GRF-1N, WVR-6R).

```ts
const terrain = [{ col: 2, row: 3, type: "lightWoods" }] as const;

let state: BattleState = createBattle(
  [
    { id: "wvr", model: "WVR-6R", team: 0, gunnery: 4,
      position: { col: 0, row: 2 }, facing: "se" },       // facing southeast
    { id: "grf", model: "GRF-1N", team: 1, gunnery: 3,
      position: { col: 8, row: 6 }, facing: "nw" },       // facing northwest
  ],
  { terrain },
);
```

`createBattle` initializes armor and ammo from the `MechDef`, validates ids,
models, and gunnery (0–7), and starts the battle in the initiative phase of
turn 1.

To load custom 'Mechs, hand `validateMechDef(JSON.parse(...))` your own
record-sheet JSON — anything invalid throws with every problem listed.

## 3. Initiative phase

```ts
state = rollInitiativePhase(state, rng);   // 2D6 per team, ties reroll
// state.initiativeWinnerTeam === 0 -> team 0 moves/fires first this round
```

The loser's team acts first each phase (classic BattleTech convention);
`nextActor(state)` tells you which unit should act next.

## 4. Movement phase

Declare a movement mode, then execute steps. Each step either enters a hex or
turns 1–5 hexsides. Costs: 1 MP per hex entered (+1 light / +2 heavy woods),
1 MP per hexside turned.

```ts
state = declareMove(state, "wvr", "run");            // running budget: 8 MP
state = executeMove(state, "wvr", [
  { kind: "enter", to: { col: 1, row: 2 } },
  { kind: "enter", to: { col: 2, row: 2 } },
  { kind: "enter", to: { col: 3, row: 2 } },
  { kind: "enter", to: { col: 4, row: 2 } },         // light woods: 2 MP
]);                                                  // 5 MP spent
```

The engine enforces budgets, backward-step rules (no running backward),
stacking (never end on another 'Mech; pass through friends only), and jump
rules (`GRF-1N` may hop over anyone but land only on empty hexes). Invalid
plans throw with a reason instead of corrupting state.

```ts
state = declareMove(state, "grf", "walk");
state = executeMove(state, "grf", []);               // walk in place
```

Advance to shooting:

```ts
state = advancePhase(state);                         // movement -> weaponAttack
```

## 5. Weapon attack phase

Declare attacks per unit (one target per turn; ammo is spent at declaration).
Weapon indexes match the model's mount order, e.g. WVR-6R:
`[0] Medium Laser (head), [1] SRM 6 (LT), [2] AC/5 (RA)`.

```ts
state = declareAttacks(state, "wvr", [
  { weaponIndex: 0, targetId: "grf" },
]);
// Wolverine ML: gunnery 4 + ran +2 + target moved 4 hexes +1
//              + medium range +2                              => TN 9

state = declareAttacks(state, "grf", [
  { weaponIndex: 0, targetId: "wvr" },
]);
// Griffin PPC:  gunnery 3 + walked +1 + wvr moved +1
//              + short range 0 + wvr in light woods +1        => TN 6
```

Declaration validates arc, line of sight (≥3 woods points blocks), range,
ammo, jams, and aborts declarations that would auto-miss (TN > 12).

Resolve in activation order — damage lands immediately on the target's armor,
but destroyed 'Mechs keep firing until the phase ends:

```ts
state = resolveDeclaredAttacks(state, "wvr", rng);   // rolls to-hit + location(s)
state = resolveDeclaredAttacks(state, "grf", rng);

const grf = getUnit(state, "grf");
grf.armor.leftTorso;   // e.g. 18 - 5 = 13 after a medium laser hit there
```

Each resolution is appended to `state.events` as an `attackResolved` event
carrying the full breakdown (to-hit roll, cluster roll, hit groups, damage
application) — enough to replay the entire battle.

Commit deaths and close the turn:

```ts
state = advancePhase(state);                         // weaponAttack -> end (kills committed)
if (!checkVictory(state).winnerTeam && !checkVictory(state).draw) {
  state = advancePhase(state);                       // end -> initiative, next turn
}
```

## 6. Ending the battle

```ts
const result = checkVictory(state);   // { winnerTeam: 0 | 1 | null, draw }
if (result.winnerTeam !== null) console.log(`Team ${result.winnerTeam} wins`);
```

A 'Mech dies when its head or center torso loses all armor; side-torso loss
blows off its arm, leg loss immobilizes it. All of this is handled inside
damage transfer — you never apply those effects manually.

## Worked example

`tests/exampleGame.test.ts` plays exactly this scenario with fully scripted
dice and asserts every rulebook number along the way (Wolverine TN 9 /
Griffin TN 6 on turn 1, then five center-torso hits at TN 6 destroy the
Griffin on turn 6). Use it as the canonical end-to-end reference.

## API cheat sheet

| Step | Call |
| --- | --- |
| Build battle | `createBattle(units, { terrain })` |
| Roll initiative | `rollInitiativePhase(state, rng)` |
| Move | `declareMove` → `executeMove` |
| Shoot | `declareAttacks` → `resolveDeclaredAttacks` |
| Advance | `advancePhase` |
| Who acts? | `nextActor(state)` |
| Done? | `checkVictory(state)` |

See `docs/API.md` for the complete reference.
