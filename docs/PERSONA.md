# Persona player: how decisions are made

The persona player (GDD §9) plays units that were assigned a MechWarrior
persona in setup (`pp <id> <persona>` or `pp setup 2|4`). It is a **one-ply
scoring player**: at each prompt it lists every option it knows, scores each one
with a weighted sum of terms, and types the commands of the best option into the
CLI. It never looks ahead to the enemy's reply and never mutates the battle; the
commands go through the normal dispatch, so atomic commits, replay recording and
rollback apply exactly as for a human.

This file describes the decision logic. The CLI side (`pp` command, driver,
trace display) is summarised in [CLI.md](CLI.md#persona-player-gdd-9).

| File | Role |
|---|---|
| `web/terminal/persona.data.ts` | the persona table: weights, range band, heat ceilings, ammo discipline, melee, jump, yield |
| `web/terminal/persona.ts` | `decide()`: strategy memory, target choice, posture, yield, scripted prompts, ranking |
| `web/terminal/persona.move.ts` | movement-phase scoring (`scoreMoves`) |
| `web/terminal/persona.attack.ts` | attack-phase scoring (`scoreAttacks`) |
| `web/terminal/persona.common.ts` | shared expected-value helpers, range profile, cover, exposure, trace types |
| `web/terminal/persona.cli.ts` | `pp` command, driver, trace rendering |
| `web/terminal/persona.setup.ts` | `pp setup 2|4` random persona-vs-persona setup |

---

## 1. The decision pipeline

`decide(session, persona, context)` runs once per prompt (one movement prompt
and one attack prompt per unit per turn). It returns the commands, a
`DecisionTrace` and the next persona context; the driver installs the context
**before** typing the commands so rollback snapshots already hold it. The caller
picks the persona: the driver passes the unit's assignment (`promptPersona`)
and leaves unassigned prompts to the human; the autoplay demo passes its default
persona for every unassigned unit.

1. **Is this prompt playable?** Only the acting unit of a movement or attack
   prompt that is still available (not destroyed, ejected or killed). Anything
   else returns `null`.
2. **Load state.** The persona's own RNG stream (seeded from the battle seed
   XOR `0x9e3779b9`, so it never touches the battle dice) and a copy of the
   unit's `StrategyMemory` (fresh on first activation: no target, posture
   `approach`).
3. **Update strategy** (`updateMemory`, §2): turn bookkeeping, target
   commitment, posture.
4. **Heat ceiling** for this turn (`heatCeilingFor`, §3.3).
5. **Clear a half-typed declaration.** If a human left a pending mode or
   queued attacks at this prompt, the commands start with `cancel`.
6. **Choose the action** for the phase:
   - Movement: yield check → scripted recovery → no target → scored moves (§4).
   - Attack: no target → `done`; otherwise scored attacks (§5).
7. **Rank.** Candidates are sorted by score. Each gets a tie-break jitter of
   `(d6 − 3.5) × 0.001` from the persona RNG, far below any displayed score
   difference, so only exact ties are decided randomly and the same seed always
   produces the same game.
8. **Trace.** The decision, every candidate with its weighted terms, and notes
   on skipped options are stored as the unit's last trace (`pp why`,
   `pp trace off|brief|full`).

Every persona runs this same pipeline; personas differ only in the numbers
in §3.

---

## 2. Strategy memory (kept per unit across turns)

### 2.1 Turn bookkeeping

On the unit's first activation in a new turn:

- `lossLastTurn` = share of own armor + structure lost since the previous turn
  (front, rear and internal structure all count; `remainingFraction`).
- Each enemy's declared move mode is tallied in `enemyModes` (groundwork for
  the §9.4 learning tag; not used in scoring yet).

### 2.2 Target choice: one committed target

Every available enemy gets a target score:

```
targetScore = EV(own usable weapons at distance d, TN = gunnery + 2)
            + 1 / d
            + (1 − enemy's remaining fraction)
```

`EV` is the expected damage of all usable weapons at that distance (§6). The
`+2` is a flat stand-in for "a typical shot" (movement and terrain are not
known yet). `1/d` and the enemy's damage break ties when nothing is in range
yet: closer and more damaged enemies win.

- No current target (first turn, or the old target is gone) → take the
  best-scoring enemy.
- Current target still alive → keep it unless another enemy scores more than
  **1.5×** the current one (`RETARGET_FACTOR`). This stops the unit from
  flip-flopping between targets every turn.
- `targetHeld` counts the turns the target has been kept.

All movement scoring and all attacks use this one target. The persona player
never splits fire across targets.

### 2.3 Posture

Posture is a label shown in the trace; it does not change any score.

| Posture | When |
|---|---|
| `engage` | the target is within the unit's longest weapon range |
| `approach` | the target is out of range |
| `hold` | Hull-Down only: the target is beyond the unit's medium range |
| `recover` | a scripted movement prompt (shut down, prone, immobile; §4.2) |
| `yield` | the unit is ejecting (§4.1) |

`turnsInContact` counts consecutive turns with the target in range.

---

## 3. The persona table

### 3.1 Behaviour settings

| Persona | Key | Range band | Heat ceiling | Ammo discipline | Melee | Jump jets | Yields at |
|---|---|---|---|---|---|---|---|
| Alpha Striker | `alpha` | short | Redline 13 | Free | opportunistic | never | 15% |
| Long Tom | `longtom` | long | Warm 7 | Conservative | never | reposition | 40% |
| Jump Jockey | `jumpjockey` | medium | Hot 9 | Measured | opportunistic | hit-and-run | 30% |
| Hull-Down | `hulldown` | any | Cold 4, Hot 9 once engaged | Conservative | opportunistic | reposition | 50% |
| Pit Fighter | `pitfighter` | short | Hot 9 | Measured | first | reposition | 20% |
| Gladiator | `gladiator` | short | Overdrive 30 | Free | seeks | hit-and-run | never |
| Dispossessed | `dispossessed` | medium–long | Cold 4 | Miser | never | reposition | 60% (+15% when ahead) |

**Heat ceilings** sit one point under a Heat Scale step (TW pp. 159–160): Cold 4
(−1 MP at 5), Warm 7 (+1 to-hit at 8), Hot 9 (−2 MP at 10), Redline 13
(shutdown check at 14), Overdrive 30 (automatic shutdown). The ceiling is the
highest *end-of-turn* heat the persona plans for (§3.3).

**Ammo discipline** (applies to ammo-fed weapons only; energy weapons always pass):

| Level | Fires only at TN ≤ | Keeps in reserve | Energy weapons first |
|---|---|---|---|
| Free | 12 | 0% | no |
| Measured | 10 | 0% | no |
| Conservative | 8 | 25% of starting shots | no |
| Miser | 7 | 50% of starting shots | yes |

**Melee:** `never` makes no physical attacks at all. `opportunistic`, `seeks`
and `first` all punch (one or both arms), kick, strike with a physical weapon,
swing a held club and drop a club when that frees better attacks (§5).
**Physical-biased** personas (`seeks` and `first`: Pit Fighter, Gladiator)
also charge and make death-from-above attacks from movement (§4.4) and pick up
clubs (§5.4).

**Jump jets:** `never` removes jump from the move list. `reposition` and
`hit-and-run` currently behave the same: jump landings are scored like any
other landing.

### 3.2 Score weights

Every persona starts from `range 1`, `tmm 0.8`, `heat 2`, `ammo 0.2`,
`crowd 0`, then sets the rest:

| Persona | cover | flank | melee (move) | exposed | tmm | crowd | ammo |
|---|---|---|---|---|---|---|---|
| Alpha Striker | 0.5 | 1.5 | 0.5 | 0.6 | 0.8 | 0 | **0** |
| Long Tom | 2 | 0.5 | 0 | 1.2 | 0.8 | 0 | 0.2 |
| Jump Jockey | 1 | **3** | 0.5 | 1 | **1.2** | 0 | 0.2 |
| Hull-Down | **3** | 0.5 | 0.5 | 1.2 | 0.4 | 0 | 0.2 |
| Pit Fighter | 0.5 | **3** | **4** | 0.5 | 0.8 | 0 | 0.2 |
| Gladiator | 0.5 | 1.5 | 2 | **0.3** | 0.8 | **1** | **0** |
| Dispossessed | 2 | 0.5 | 0 | **1.5** | 0.8 | 0 | **0.5** |

The melee *preference* also sets a melee factor that scales every expected
physical damage (charge and DFA in §4.5, attacks in §5.3; `MELEE_FACTOR` in
`persona.data.ts`): never 0, opportunistic 1, seeks 1.2, first 1.5.

### 3.3 Heat ceiling this turn

`heatCeilingFor` returns the persona's ceiling. Hull-Down is the only persona
with two values: it plans for Cold 4 while the target is beyond its medium
range and Hot 9 once the target is within it.

Heat is always projected the same way:

```
projected = current heat + heat already pending this turn
          − heat sinks' dissipation (heatDissipation)
          + heat the option adds (movement heat or weapon heat)
heatOver  = max(0, projected − ceiling)
```

Water cooling is not included in the projection.

---

## 4. Movement phase

### 4.1 Yield (checked first)

```
yieldAt = persona.yieldAt
        + 0.15  if the persona yields when ahead (Dispossessed) and
                own remaining fraction − target's remaining fraction > 0.15
```

If `yieldAt > 0` and the unit's remaining armor + structure is at or below
`yieldAt`, the unit yields: `mode eject`, `done`. A persona that never melees
(Long Tom, Dispossessed) also yields once it has no usable weapons left.
Ejection stands in for a proper yield rule (GDD R6). Gladiator (`yieldAt 0`)
never yields.

Abandoned enemy 'Mechs (hulls) are never the committed target. When no attack
on the live target scores above zero, the attack scorer also tries every enemy
hull and fires on one to deny the enemy its salvage (`pp.note.hullTarget`).

### 4.2 Scripted recovery

Prompts the scorer does not handle are scripted (mirrors `web/terminal/autoplay.ts`):

| Situation | Commands |
|---|---|
| Shut down (heat or manual) | `done` |
| Prone and cannot stand (immobile, legs or gyro prevent it, or too few MP) | `mode pronestill`, `done` |
| Prone and can stand | `mode standup walk`, `done` (stands in place) |
| Standing but immobile or 0 walk MP | `mode standstill`, `done` |

"Too few MP" means walk MP below the stand-up cost (2) with both legs, or below
1 at all.

### 4.3 No target

If no enemy is left to target: `mode standstill`, `done`.

### 4.4 Candidate moves

Modes considered:

- `standstill`: always (one candidate: current hex and facing).
- `walk`: if walk MP > 0.
- `run`: if no leg is destroyed and run MP > walk MP.
- `jump`: if the persona uses jump jets and jump MP > 0.

MP budgets come from `effectiveMovement` + `effectiveMoveBudget`, so leg and
actuator damage, heat MP loss, TSM and the depth of water the unit stands in
are already applied. For each mode every reachable landing from
`reachableLandings` (each hex × facing, with the engine's own terrain, climb,
water, wreckage and hull-stacking rules) becomes one candidate; landings with an empty path are
dropped (standstill covers staying put), and duplicates are removed.

**Charge and DFA landings** (physical-biased personas only). The engine's
`reachableLandings` is also given a `meleeOk` check, the same one the `mode`
command uses: a walk or run path may end with one step into the committed
target's hex (a charge), and a jump path may end in it (a DFA), whenever
`meleeDeclarationProblem` accepts the declaration (target adjacent to the stop
hex, stop hex free and not reserved, the target not already charged, enough
jump MP to clear a standing target for a DFA, and every other check of
`validatePhysicalAttack`). Hexes reserved by another unit's declared charge
count as occupied, as they do for the `mode` command. Such a landing stops the
unit in the hex before the target's (TW pp. 148–150, no displacement) and
declares the attack; the unit then makes no attacks in the attack phase.

The winning candidate becomes `mode <walk|run|jump>`, `place <col> <row> <facing>`,
`done`, or `mode standstill`, `done`. For a charge or DFA, `place` names the
target's hex.

### 4.5 Move score

For each landing (hex `H`, facing `F`, mode `M`, `d` = distance from `H` to
the target):

```
score = range   × w.range
      + cover   × w.cover
      + tmm     × w.tmm
      + flank   × w.flank
      + melee   × w.melee
      + charge                (charge / DFA landings only)
      − recoil  × w.exposed   (charge / DFA landings only)
      − exposed × w.exposed
      − heatOver× w.heat
      + crowd   × w.crowd
```

**range** = firepower − 0.5 × |d − preferred distance|

- *Firepower*: expected damage (§6) of own usable weapons from `H` at the
  target, with LOS checked (0 without LOS). It is the best of three torso
  positions (facing `F`, and one hexside left or right), keeping only weapons
  whose mount can fire into that arc. The to-hit base is
  `gunnery + attacker movement modifier of M` (TW p. 106) `+ target's movement
  modifier this turn + target hex defense (§4.6) + current heat to-hit modifier`.
  So running and jumping lower firepower through the attacker modifier.
- *Preferred distance* (`rangeProfile`): the distance inside the persona's
  range band where the unit's own weapons deal the most expected damage at
  TN `gunnery + 2`. Bands are measured in the unit's own brackets: short =
  1…longest short range, medium = next hex…longest medium range, long =
  next hex…longest long range, medium–long, any = 1…longest long range. On a
  tie, short personas keep the nearer distance and the others the farther.
  If the band is empty for this 'Mech, the whole 1…long span is used.

**cover** = defense of hex `H` (§4.6): woods and partial cover make the unit
harder to hit.

**tmm** = the target movement modifier this move would give the unit
(hexes entered, +1 for a jump; TW p. 107). Turning in place enters no hex.

**flank** (only when `d` is within own long range) = 1 if `H` is in the
target's rear arc, 0.3 in a side arc, 0 in its front arc.

**melee** = 1 if adjacent (`d ≤ 1`), 0.3 at `d = 2` (one step from contact),
else 0.

**exposed** = sum over every enemy with LOS to `H` of that enemy's expected
damage against the unit at `H`, using the enemy's gunnery, its declared
movement modifier (an enemy that has not moved yet is assumed to walk, +1),
its heat to-hit modifier, the unit's new tmm and the hex defense of `H`.
Enemy arcs are ignored (they can still turn), so the unit does not try to hide
its own rear.

**heatOver** = projected end-of-turn heat with movement heat for `M` and the
MP spent (walk 1, run 2, jump max(3, hexes); TW p. 159) above the ceiling.

**crowd** (Gladiator only) = 1 if `d ≤ 3` and `H` is in the target's front
arc: fighting face to face where the crowd can see it.

**Charge / DFA landings.** `H` is the stop hex (the one before the target's),
so `d = 1`, and the terms change as follows:

- *range*: firepower is 0, since a charging unit fires no weapons that turn.
- *tmm*: counts the hexes moved before the stop, since the last change of
  direction (the way `executeMove` records them).
- **charge** = melee factor × P(hit) × damage. The to-hit and damage come from
  the engine (`computePhysicalToHit`, `physicalDamage`) for the unit as it will
  stand at the stop hex after this move: its mode, hexes moved and jump. The
  charge to-hit uses piloting, the piloting difference and both movement
  modifiers; charge damage grows with the hexes moved; a DFA deals 3 × tonnage
  / 10 (TW pp. 144, 148–150).
- **recoil** = damage the unit expects to take itself, weighed by its own
  `exposed` weight: P(hit) × recoil (a charger takes target tonnage / 10, a DFA
  attacker its own tonnage / 5; `meleeRecoilDamage`), plus for a DFA
  (1 − P(hit)) × the falling damage of a missed DFA (`fallingDamageTotal` for
  2 levels fallen, TW p. 150).

So a charge wins when its expected damage beats the weapons the unit would
otherwise fire from its best hex. A Pit Fighter values contact so highly
(melee weight 4, factor 1.5) that it charges whenever it can reach the target.

### 4.6 Hex defense

`hexDefenseMod(hex)` = the terrain's to-hit modifier (light woods +1, heavy
woods +2, …) + 1 if the terrain carries the partial-cover flag (any water
hex and any building). Elevation is not considered; LOS (including deep water and
elevation) is checked separately with `losClear`.

---

## 5. Attack phase

### 5.1 Candidates

1. **Hold fire** (`done`), score 0. Any option must beat doing nothing.
2. For each torso position (front, twist left, twist right; front only when
   prone):
   - **Weapons only**: the best weapon set (§5.2) against the committed
     target from `suggestFireTargets` for that twist (arcs, LOS, range and the
     prone prop-arm choice come from the engine; when prone the prop variant
     with more expected damage is used). While the unit holds a club, its arm
     weapons are left out (both hands are on the club).
   - **Drop the club and fire** (only while holding a club): the same, with
     the arm weapons back in.
   - **Weapons + a physical plan** (only if the persona's melee is not
     `never` and the target is adjacent). The plans are:
     - punch with the left arm, the right arm, or **both arms** (two rolls;
       the one exception to one physical attack type per turn, TW p. 144);
     - kick with the left or right leg (front only, since a kick ignores the
       torso twist);
     - **strike** with each mounted physical weapon (hatchet, sword,
       retractable blade; `strikeMounts`), one per turn;
     - **club** swing, while holding a club (no arm weapons that turn).

     While a club is held, punches and strikes are planned with a `drop`
     first, which frees both hands. The weapon set is rebuilt without the
     weapons in any limb the plan uses (every arm for a club; TW pp. 144–146).
3. **Pick up a club** (physical-biased personas only, §5.4).

Every plan is checked as one whole declaration (weapons, physical attacks,
twist and drop together) by the engine's `validateAttacks`, the same check the
`done` command runs, so the persona player never types an illegal set. If the
plan is legal on its own but not with its weapon set, it is scored without
weapons.

The winner's commands are `torso <left|right>` (if twisted), `drop` (if
dropping), `fire <target> <weapon indices>`, the physical attacks
(`punch <target> left`, `punch <target> right`, `kick <target> right`,
`strike <target> right`, `club <target>`, …) and `done`, or
`pickup <source>`, `done`.

### 5.2 Weapon set (`pickVolley`)

1. Drop ammo weapons the ammo discipline forbids: to-hit above the persona's
   maximum TN, or firing would leave fewer shots than
   `ceil(starting shots × reserve)` for that weapon type. Each skip is noted in
   the trace.
2. Sort the rest by expected damage per heat, `EV / (heat + 1)`, best first
   (Miser puts every energy weapon ahead of every ammo weapon).
3. Add weapons in that order while
   `current heat + pending − dissipation + volley heat ≤ heat ceiling`. A
   weapon that would cross the ceiling is skipped (noted) and cheaper ones
   later in the list may still fit. Weapons with zero expected damage are not
   fired.

So the heat ceiling works as a hard budget for weapons; the `heat` term only
bites when the unit is already above its ceiling before firing.

### 5.3 Attack score

```
score = ev            (expected damage of the weapon set, §6)
      + melee value   (physical options only)
      − w.ammo × number of ammo-fed weapons fired
      − w.heat × heatOver
```

**Melee value** = the sum over the plan's physical attacks of melee factor ×
P(hit) × damage, with to-hit and damage taken straight from the engine
(`computePhysicalToHit`, `physicalDamage`; TW pp. 145–147): punch tonnage / 10
per arm, kick tonnage / 5 at −2, club tonnage / 5 at −1, physical weapons by
their own table, all with actuator damage and TSM applied. Melee factor:
opportunistic 1, seeks 1.2, first 1.5.

**Kick caution**: a missed kick forces a piloting roll (TW p. 147), so
opportunistic personas (Alpha Striker, Jump Jockey, Hull-Down) skip kicks
whose to-hit is above 8. Seeks and first personas kick at any to-hit.

The `ammo` term makes ammo-conscious personas (Dispossessed 0.5, most at 0.2)
prefer energy weapons when the damage is close; Alpha Striker and Gladiator
(0) shoot ammo freely.

### 5.4 Club pickup

A physical-biased persona that holds no club and stands where the engine's
`validatePickup` finds one (a severed limb or dropped club lying in the hex, a
tree in woods, a girder in the rubble of a medium or heavier building; two working
hands needed) also scores
`pickup <source>`. Picking up is the unit's whole attack that turn (TW p. 146),
and the club only pays off later, so the score is:

```
pickup = 0.5 × ( club swing value
               − best bare-handed value (one kick, or both punches)
               − expected damage of the arm weapons the club would bar )
```

each at the current distance to the target. It is offered only when positive.
A club deals the same damage as a kick at a worse to-hit, so in practice a
unit picks one up only when its legs cannot kick well and its arms carry
little firepower.

---

## 6. Expected damage

All scores use the same expected-value model (`persona.common.ts`):

- **Hit chance** = P(2D6 ≥ TN) (TW p. 106); 2 or less always hits, above 12
  never hits.
- **TN for a weapon** = base + range bracket (short 0, medium +2, long +4;
  TW p. 109) + minimum-range penalty `min − d + 1` (TW p. 110) + the weapon's
  own to-hit modifier. Out of range = no contribution.
- **Damage of one hit**: the bracket damage; missile weapons use the average
  of the Cluster Hits Table (TW p. 116), or the full rack for Streak.
- **Expected damage** = Σ hit chance × damage of one hit.
- **Usable weapons**: not destroyed or jammed, mounted in a location that can
  still fire, with live ammunition left for ammo-fed weapons. Physical weapons
  (hatchet, sword, retractable blade) are not ranged weapons; they are used
  through `strike` (§5.1).

---

## 7. How each persona plays

These follow from the numbers above; they are tendencies, not scripts.

**Alpha Striker** wants short range and fires everything up to Redline 13 with
no ammo limits. Low cover and exposure weights mean it walks straight in. It
never jumps. When adjacent it punches, kicks or strikes, but avoids kicks above
TN 8, and it never charges.
It fights until 15% is left.

**Long Tom** sits at its longest brackets (the preferred distance is picked
inside the long band), values cover (2) and fears exposure (1.2), and keeps its
heat under 7, so it rarely runs or jumps while firing heavy weapons. It never
melees, saves a quarter of its ammo, and yields at 40%, or as soon as its guns
are gone.

**Jump Jockey** holds medium range and puts the most weight on flanking (3)
and on its own movement modifier (1.2), so long jumps that land in the
target's side or rear arcs score well despite the +3 attacker penalty. It runs
up to Hot 9, fires ammo up to TN 10, melees opportunistically and yields at 30%.

**Hull-Down** has the highest cover weight (3) and a low value on its own
movement (0.4), so it picks woods and partial cover and moves little. It
stays cold (4) while the target is far and warms up to 9 once it is within
medium range. Posture shows `hold` while the target is beyond medium range. It
is conservative with ammo and yields at 50%.

**Pit Fighter** goes for contact: melee weight 4 on the move (adjacent hexes
score +4, two hexes away +1.2), flank 3, low fear of exposure (0.5), and a melee
factor of 1.5. It charges or makes a DFA whenever it can reach its target, and
once adjacent it kicks (at any to-hit), punches with both arms, or swings its
hatchet or club, whichever the numbers favour. It picks up a club when that
beats its bare hands. It runs Hot 9 and yields at 20%.

**Gladiator** is the showman: short range, melee weight 2, crowd bonus for
fighting face to face within 3 hexes, the lowest exposure weight (0.3), no heat
limit short of automatic shutdown (30), free ammo use, and it never yields. Its
physical attacks get a 1.2 melee factor: it charges and makes DFAs when they
beat its guns, kicks at any to-hit, and uses both punches, strikes and clubs
like the Pit Fighter.

**Dispossessed** cannot afford to lose its 'Mech: it holds medium to long
range, values cover (2), has the highest exposure weight (1.5), stays Cold 4,
fires ammo only at TN ≤ 7 while keeping half of it, and prefers energy weapons.
It never melees. It yields at 60%, or at 75% while it is ahead of its target on
remaining armor and structure.

---

## 8. Determinism and rollback

- The persona RNG is separate from the battle dice and only breaks exact
  ties, so deciding never changes a battle roll and the same seed replays the
  same game.
- The persona context (assignments, RNG state, memory, last traces) is plain
  data on `Session.persona` and is part of every prompt snapshot. After
  `rollback`, a persona prompt waits; `pp go` replays the identical decision,
  or the human can play that prompt by hand.
- A command that fails stops the driver and hands the prompt to the human. The
  driver also stops after 2000 decisions in one drive (a stalled bout).

---

## 9. What the persona player does not do yet

The engine supports these, but the persona player never chooses them:

- **Charge and DFA for non-physical-biased personas**: only Pit Fighter and
  Gladiator charge.
- **Seeking out clubs**: movement does not head for woods or rubble to pick one
  up; a club is taken only where the unit already stands.
- **Moving after standing up**: it stands in place and forfeits the remaining MP.
- **Voluntary prone, prone turns, voluntary shutdown, startup** (a manually
  shut-down unit only answers `done`).
- **One-legged minimum-movement run** (TW p. 49).
- **Secondary targets**: all fire goes to the committed target.
- **Different jump styles**: `reposition` and `hit-and-run` score the same.
- **Water cooling and elevation** in hex scoring; own rear-arc exposure.
- **Posture-driven behaviour**: posture is recorded but does not change scores.
