# btlib10x Scoring

How `scoreReport` scores a battle. The score is a read-only view of the
current `BattleState`, valid at any moment: after any phase, at a turn limit
the caller enforces, or at the end. The engine still never decides a winner
(`docs/VISION.md` §1); what a caller does with the score (a winner at a turn
limit, a victory level, salvage) is outside this document.

## 1. Model

The score follows the *Total Warfare* Battle Value victory rule (TW p.257):
each side earns twice the value of what it took from the enemy and loses the
value of what it lost itself. btlib10x extends "what it lost" from destroyed
units only to a fraction of every unit's value, so a score read mid-battle
or at a turn limit reflects crippling and partial damage too.

```
score(team) = 2 × Σ V(e) × lost(e)   over enemy units e
            − 1 × Σ V(o) × lost(o)   over own units o
```

Every team in the battle counts as an enemy of every other. The score is
rounded to an integer at the end, never in between.

## 2. Unit value V

```
V(u) = round(BV(model) × M(gunnery, piloting))
```

### 2.1 Battle Value

`BV` is the Master Unit List Battle Value of the model, rated for a regular
4/5 MechWarrior. It is catalog identity, like the introduction year:

| Stage | Where |
|---|---|
| Source | each pack's `docs/mtf/<pack>/roster.json` (`bv`, MUL values) |
| Sheet | MTF `BV:N` header, on the line after `Intro:` (`docs/MTF.md`) |
| JSON | `MechDef.bv`, required, integer ≥ 0 (`validateMechDef`) |
| Pack | manifest entry key `v` (`scripts/pack-catalog.mjs`) |
| Runtime | `MechManifestEntry.bv` → `ResolvedMechDef.bv` when the sheet is built |

A manifest entry without `bv` fails to load. `BV:0` marks a sheet the MUL
lists no BV for (a few named or archive variants); such a unit is worth 0
and moves no score. The base pack's 15 'Mechs all carry a MUL value.

### 2.2 Skill multiplier

`M` is the TechManual skill multiplier (TM p.315), `BV_SKILL_MULTIPLIER`,
indexed `[gunnery][piloting]` with both clamped to 0..8. Regular 4/5 is
1.00. Skills are read from the unit as it stands; the engine never changes
them mid-battle.

| G \ P | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 2.42 | 2.31 | 2.21 | 2.10 | 1.93 | 1.75 | 1.68 | 1.59 | 1.50 |
| 1 | 2.21 | 2.11 | 2.02 | 1.92 | 1.76 | 1.60 | 1.54 | 1.46 | 1.38 |
| 2 | 1.93 | 1.85 | 1.76 | 1.68 | 1.54 | 1.40 | 1.35 | 1.28 | 1.21 |
| 3 | 1.66 | 1.58 | 1.51 | 1.44 | 1.32 | 1.20 | 1.16 | 1.10 | 1.04 |
| 4 | 1.38 | 1.32 | 1.26 | 1.20 | 1.10 | **1.00** | 0.95 | 0.90 | 0.85 |
| 5 | 1.31 | 1.19 | 1.13 | 1.08 | 0.99 | 0.90 | 0.86 | 0.81 | 0.77 |
| 6 | 1.24 | 1.12 | 1.07 | 1.02 | 0.94 | 0.85 | 0.81 | 0.77 | 0.72 |
| 7 | 1.17 | 1.06 | 1.01 | 0.96 | 0.88 | 0.80 | 0.76 | 0.72 | 0.68 |
| 8 | 1.10 | 0.99 | 0.95 | 0.90 | 0.83 | 0.75 | 0.71 | 0.68 | 0.64 |

The values are pending a check against a TechManual copy.

## 3. Lost fraction

| Unit state now | `lost(u)` |
|---|---|
| Out of play (`removed !== "not"`): wreckage or hull | 1.0 |
| In play and crippled (§3.2) | 0.5 |
| In play, not crippled | 0.5 × damaged(u) |

A hull counts as lost for its team the moment its pilot leaves
(`docs/VISION.md` §2.1); destroying it later changes nothing. Pilot state
counts only through the unit: a pilot who leaves makes a hull, and 4+ pilot
hits cripple. Killing or wounding a MechWarrior moves the score no further.

### 3.1 Damaged

```
damaged(u) = (armor + rear armor + internal structure lost)
           / (armor + rear armor + internal structure of the sheet)
```

Measured against the sheet's full values, so a unit seeded with starting
damage (`UnitInit.damage`) already shows some loss. A destroyed or severed
location counts as fully lost. Damage never heals, so `lost` of a unit in
play only grows. The 0.5 cap keeps armor damage alone from ever outweighing
a crippled or destroyed unit.

### 3.2 Crippled

A unit in play is crippled when any TW p.258 crippling-damage condition
holds (`crippleReasons`, which reports every reason that applies):

| Reason | Condition |
|---|---|
| `sideTorsoDestroyed` | left or right torso has no structure left |
| `engineHits` | 2+ engine slots destroyed |
| `gyroAndEngineHits` | 1 engine + 1 gyro slot destroyed |
| `sensorsLost` | both sensor slots destroyed (`SENSOR_BLIND_HITS`) |
| `limbStructureDamage` | structure damage in 3+ of the four limbs |
| `torsoStructureDamage` | structure damage in 2+ torso locations whose front armor is gone |
| `pilotHits` | 4+ pilot hits |
| `allWeaponsLost` | no working weapon with long range > 5 hexes, and the working weapons deal ≤ 5 combined |

For `allWeaponsLost`, a weapon works when its mount can fire
(`canFireMount`), none of its slots is destroyed, and, if the sheet feeds it
from ammo bins, its shared pool still has shots. A weapon's damage is its
best bracket (direct and variable damage) or `missiles × missileDamage`,
times rapid-fire shots. Physical weapons do not count. A unit whose full
design never clears the bar can never lose all its weapons (TW p.258).

## 4. Examples

All pilots 4/5 unless noted. Sheet totals (armor + rear + structure):
HBK-4G 243, CDA-3MA 203. BV: HBK-4G 1,041, CDA-3MA 1,158, ENF-4R 1,032,
WVR-6R 1,101.

### 4.1 Quickstart duel, read every turn

HBK-4G is team 1, CDA-3MA team 2.

| When | HBK-4G | CDA-3MA | score(1) | score(2) |
|---|---|---|---|---|
| Start | 0 | 0 | 0 | 0 |
| Turn 3 | lost 36 points: lost 0.074 | lost 30 points: lost 0.074 | 94 | 69 |
| Turn 5 | lost 60: lost 0.123 | left torso gone, crippled: 0.5 | 1,029 | −322 |
| Turn 6 | unchanged | cored, wreckage: 1.0 | 2,187 | −901 |

Turn 3: `score(1) = 2 × 1,158 × 0.074 − 1,041 × 0.074 = 94`. Equal damage
leaves team 1 ahead, because it damaged the more valuable unit.

### 4.2 Two on two, read at a turn limit

Team 1: HBK-4G and WVR-6R with a 3/5 pilot (V = 1,101 × 1.20 = 1,321).
Team 2: CDA-3MA and ENF-4R.

| Unit | State | lost |
|---|---|---|
| HBK-4G | in play, lost 97 of 243 | 0.20 |
| WVR-6R | wreckage | 1.0 |
| CDA-3MA | hull, pilot ejected | 1.0 |
| ENF-4R | in play, crippled by 4 pilot hits | 0.5 |

- score(1) = 2 × (1,158 + 1,032 × 0.5) − (1,041 × 0.20 + 1,321) = **1,819**
- score(2) = 2 × (1,041 × 0.20 + 1,321) − (1,158 + 1,032 × 0.5) = **1,384**

## 5. API

```ts
scoreReport(state: BattleState): TeamScore[]     // ascending team order
interface TeamScore {
  team: number;
  score: number;        // rounded
  lostValue: number;    // Σ value × lost of this team's units
  units: UnitScore[];
}
interface UnitScore {
  unitId: string; model: string; team: number;
  bv: number;           // MUL BV of the model
  value: number;        // V
  damaged: number;      // 0..1
  crippled: CrippleReason[];  // empty when not crippled or out of play
  outOfPlay: boolean;
  lost: number;
}
```

Also exported: `unitScore(unit)`, `crippleReasons(unit)`,
`damagedFraction(unit)`, `bvSkillMultiplier(gunnery, piloting)`, and the
constants `BV_SKILL_MULTIPLIER`, `SCORE_ENEMY_WEIGHT` (2),
`SCORE_OWN_WEIGHT` (1), `SCORE_CRIPPLED_LOST` (0.5). Source:
`src/rules/score.ts`; tests: `tests/score.test.ts`.

## 6. Kill credit

The team score needs no credit; per-unit credit rides on the `unitRemoved`
event as `credit: KillCredit[]` (`{ unitId, damage, share }`), computed by
`killCredit(state, unit)` at the moment the unit leaves play.

- **The killing window.** Credit comes only from the damage window that
  removed the unit: the weapon sub-pass (with its piloting sweep), the
  physical sub-pass (with its sweep), or the move of a unit whose
  accidental fall hit it. Attacks in a sub-pass resolve simultaneously
  (`resolveAllAttacks`), so the order of `attackResolved` events is only
  declaration order and there is no real last hit: every enemy that dealt
  the unit damage in that sub-pass shares the kill. Damage from earlier
  turns or the other sub-pass does not count.
- **Shares.** Each enemy gets the armor + structure points it dealt the unit
  in that window, weapon or physical hits plus the critical-hit blasts
  they set off, over the enemies' total there, so shares sum to 1. Only
  points actually marked count, so overkill past a location's last
  structure adds nothing. Teammates and self-damage earn nothing. Largest
  share first, ties by unit id.
- **Empty credit.** A removal with no enemy damage in its window (heat, the
  unit's own fall or failed stand, ejection or abandonment) has empty
  credit. So does the second `unitRemoved` of a hull destroyed later:
  the unit was credited when it left play.

Example: a Wolverine strips 18 points off an Enforcer in turn 3. In turn 4
a Hunchback's medium lasers deal 6 (5 to the head for the sixth pilot hit,
1 to the bare center torso) in a weapon sub-pass where nobody else hits
the Enforcer. The `pilotKilled` event credits the Hunchback alone, share 1;
the frame's `destroyed` event that follows has empty credit.

`UnitState.damageTakenFrom` separately keeps the battle-long total each
attacker dealt the unit (every source above). It is part of the snapshot and
does not feed kill credit.

### 6.1 Damage windows

The engine records damage through one transient field,
`BattleState.currentDealt` (`DealtWindow`), that the TW p.60 20-point
piloting roll shares with kill credit. A window starts with one unit's
move, the weapon sub-pass, the physical sub-pass and the heat phase, each
closed by its piloting sweep, and with each stand-up or drop, ejection and
abandonment, which have nothing in scope. It holds:

| Field | Meaning |
|---|---|
| `before` | the units in scope, as they stood when the window opened |
| `total` | marked points per unit in scope: the 20-point trigger |
| `byAttacker` | marked points per target, then per attacker: kill credit |

Every marked point goes through one call, `creditDealt(state, target,
attackerId | null, n)`: to `total` when the target is in scope, and, with
an attacker other than the target, to `byAttacker` and `damageTakenFrom`.
Only the mover is in a move's scope, so damage it causes other units (an
accidental fall, a building collapse) rolls no piloting check for them but
still earns the mover credit. Each start assigns a fresh window before
any damage lands, and the window stays until the next start, so a unit the
attack-to-end destroyed-mark check catches is credited from the physical
sub-pass. Snapshots never save it, and loading one clears it.
