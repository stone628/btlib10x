# Reference Tables

BattleTech numeric lookups used when designing or analyzing 'Mechs. Values are
Inner Sphere tabletop rules (Total Warfare / BattleMech Manual construction),
**not** the MechWarrior Online video-game adaptation, which scales numbers up
(among other changes). The internal-structure table below mirrors
`STANDARD_INTERNAL_STRUCTURE` / `internalStructureForTonnage` in
`src/rules/internalStructure.ts`, from which `ResolvedMechDef.internalStructure`
is derived at resolve time.

## Internal Structure

The internal structure of a BattleMech is the skeleton that holds every other
component. Each location carries a fixed number of internal structure (IS)
points determined **solely by the 'Mech's tonnage** — it does not depend on the
structure type. The head is always **3** points; torso points cover front + rear
combined (armor alone splits front/rear).

### Points by location

| Tonnage | Head | Center Torso | Side Torso (each) | Arm (each) | Leg (each) |
| --- | --- | --- | --- | --- | --- |
| 20 | 3 | 6 | 5 | 3 | 4 |
| 25 | 3 | 8 | 6 | 4 | 6 |
| 30 | 3 | 9 | 7 | 5 | 7 |
| 35 | 3 | 11 | 8 | 6 | 8 |
| 40 | 3 | 12 | 10 | 6 | 10 |
| 45 | 3 | 14 | 11 | 7 | 11 |
| 50 | 3 | 16 | 12 | 8 | 12 |
| 55 | 3 | 18 | 13 | 9 | 13 |
| 60 | 3 | 20 | 14 | 10 | 14 |
| 65 | 3 | 21 | 15 | 11 | 15 |
| 70 | 3 | 22 | 15 | 11 | 15 |
| 75 | 3 | 23 | 16 | 12 | 16 |
| 80 | 3 | 25 | 17 | 13 | 17 |
| 85 | 3 | 26 | 18 | 14 | 18 |
| 90 | 3 | 29 | 19 | 15 | 19 |
| 95 | 3 | 30 | 20 | 16 | 20 |
| 100 | 3 | 31 | 21 | 17 | 21 |

### Structure types

Both chassis types use the same points table above. They differ in **weight**
and **critical slots** only:

| Type | Weight | Critical slots | Points |
| --- | --- | --- | --- |
| Standard | 10% of tonnage | 0 | per table above |
| Endo-Steel | 5% of tonnage (half of standard) | 7 (Clan) / 14 (Inner Sphere) | per table above |

Endo-steel gives **no extra internal structure points** in the core rules — it
is simply a lighter chassis that costs critical slots (7 slots Clan / 14 Inner
Sphere). The 1.5×-points bonus belongs to advanced **reinforced** structure
(outside the current subset).

### Armor limits

- **Maximum armor per location = 2 × its internal structure points** (e.g. an
  arm with 8 IS points may carry up to 16 armor points).
- The **head** maxes out at **9** armor points regardless of tonnage.

## Hit Location

Bipedal 'Mech hit-location tables (`src/rules/hitlocation.ts`). Front and rear
share the **same** column (rear only changes which armor pool is drained, via the
firing arc); left/right side arcs use their own mirrored tables. "H" = head.

Front / Rear (`HIT_LOCATION_TABLE`):

| Roll | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hit | CT | RA | RA | RL | RT | CT | LT | LL | LA | LA | H |

Left side (`LEFT_SIDE_TABLE`):

| Roll | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hit | LT | LL | LA | LA | LL | LT | CT | RT | RA | RL | H |

Right side (`RIGHT_SIDE_TABLE`):

| Roll | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hit | RT | RL | RA | RA | RL | RT | CT | LT | LA | LL | H |

## Firing Arc

Total Warfare arc classification (`src/rules/arcs.ts`). Two classifiers share
the four arcs (front / rightSide / rear / leftSide):

- **Attacker side** — `classifyFiringArc` applies the TW p.105 hex template:
  every hex around the attacker falls wholly in one arc (the forward arc is
  three hexes wide, facing ±1 included), so firing has no boundary pairs. A
  weapon may fire into an arc only if its mounting allows it
  (`weaponCanFireIntoArc`): head, legs and front-torso weapons fire front
  only, arm weapons add their own side, `rearFacing` torso weapons fire rear
  only. A torso twist shifts the effective facing one hexside
  (`effectiveFacingForTwist`).
- **Target side** — `classifyArcWithBoundary` classifies from the bearing to
  the attacker as a clockwise offset from the *target's* facing (the attack
  direction, TW p.119). On an exact boundary line the defender's dominant
  choice wins (front over side, never rear).

The attack direction picks the hit-location column and the armor pool:

| Offset from target facing | Arc | Hit-location table | Armor pool |
| --- | --- | --- | --- |
| 0–1, 5 | front | Front / Rear | front |
| 2 | rightSide | Right side | front |
| 3 | rear | Front / Rear | rear (torso) |
| 4 | leftSide | Left side | front |

## Facing After a Fall

Total Warfare p.68 (`rollFallDirection` in `src/rules/piloting.ts`).
Shifts run clockwise (positive = right) from the 'Mech's facing.

| 1D6 | New facing | Hit-location column |
| --- | --- | --- |
| 1 | Same direction | Front |
| 2 | 1 hexside right | Right side |
| 3 | 2 hexsides right | Right side |
| 4 | Opposite direction | Rear |
| 5 | 2 hexsides left | Left side |
| 6 | 1 hexside left | Left side |

Falling damage is `ceil(tonnage / 10) × (levels fallen + 1)` in 5-point
clusters on the rolled column; levels fallen measure underlying terrain
(hex fell into minus hex the fall began from — a fall across levels drops
into the lower hex; jump-phase falls count 0 levels per errata). A fall
underwater (depth 2+) halves the total, rounding down (TW errata, p.57 —
an explicit exception to the usual round-up convention). A 'Mech walking
into water from above the surface takes two halved packets instead (TW p.57):
surface impact `ceil(t/10) × (levels fallen + 1) / 2` plus bottom impact
`ceil(t/10) × (depth + 1) / 2`, each rounded down; a jump landing in water
falls `depth` levels, halved (TW p.53). The pilot then
rolls a seatbelt PSR (failed roll's modifiers, +5 off a destroyed leg, +6
off a destroyed gyro, +1 per level above 1 fallen) or takes 1 hit.

## Cluster Hits

Cluster Hits Table (`src/rules/cluster.ts`, Total Warfare p. 116). Each row
is the 2D6 roll; each entry is the number of projectiles that hit. The column
is the weapon size: the missile count for LRM/SRM launchers, or the shots
fired for rapid-fire (Ultra autocannon) attacks — both share this one table.

| Roll | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 40 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 1 | 1 | 1 | 2 | 2 | 2 | 3 | 3 | 4 | 4 | 4 | 5 | 5 | 5 | 5 | 6 | 6 | 6 | 7 | 7 | 7 | 8 | 8 | 9 | 9 | 9 | 10 | 10 | 12 |
| 3 | 1 | 1 | 2 | 2 | 2 | 2 | 3 | 3 | 3 | 4 | 4 | 4 | 5 | 5 | 5 | 5 | 6 | 6 | 6 | 7 | 7 | 7 | 8 | 8 | 9 | 9 | 9 | 10 | 10 | 12 |
| 4 | 1 | 1 | 2 | 2 | 3 | 3 | 3 | 4 | 4 | 5 | 5 | 5 | 6 | 6 | 7 | 7 | 8 | 8 | 9 | 9 | 9 | 10 | 10 | 10 | 11 | 11 | 11 | 12 | 12 | 18 |
| 5 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 5 | 6 | 7 | 8 | 8 | 9 | 9 | 10 | 10 | 11 | 11 | 12 | 13 | 14 | 15 | 16 | 16 | 17 | 17 | 17 | 18 | 18 | 24 |
| 6 | 1 | 2 | 2 | 3 | 4 | 4 | 4 | 5 | 6 | 7 | 8 | 8 | 9 | 9 | 10 | 10 | 11 | 11 | 12 | 13 | 14 | 15 | 16 | 16 | 17 | 17 | 17 | 18 | 18 | 24 |
| 7 | 1 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 6 | 7 | 8 | 8 | 9 | 9 | 10 | 10 | 11 | 11 | 12 | 13 | 14 | 15 | 16 | 16 | 17 | 17 | 17 | 18 | 18 | 24 |
| 8 | 2 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 6 | 7 | 8 | 8 | 9 | 9 | 10 | 10 | 11 | 11 | 12 | 13 | 14 | 15 | 16 | 16 | 17 | 17 | 17 | 18 | 18 | 24 |
| 9 | 2 | 2 | 3 | 4 | 5 | 6 | 6 | 7 | 8 | 9 | 10 | 11 | 11 | 12 | 13 | 14 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 21 | 22 | 23 | 23 | 24 | 32 |
| 10 | 2 | 3 | 3 | 4 | 5 | 6 | 7 | 7 | 8 | 9 | 10 | 11 | 11 | 12 | 13 | 14 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 21 | 22 | 23 | 23 | 24 | 32 |
| 11 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 40 |
| 12 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 40 |

LRM missiles are applied in lots of **five**: a hit lot lands on one location
(e.g. an LRM-10 firing 8 hits produces lots of 5 and 3, each on its own
location).

Streak launchers skip this table: successful to-hit roll lands full tube
count (SRM: one location roll per missile); failed roll fires nothing (no
ammo spent, no heat). Launchers share one ammo pool per weapon name: when
an earlier launcher drains pool mid-resolution, a later launcher with
nothing left auto-misses without rolling (declaration order sets ammo
priority; resolution logs an out-of-ammo note). The pool is read from the
attacker's bins as they stood at the start of the phase, so damage or
crits other attacks deal it in the same phase never void its volley.

## Critical Hits

Whenever a hit strips at least 1 point of internal structure from a
location — or the hit-location roll is a 2 (through-armor critical: damage
lands on armor normally, plus one determining roll) — the player rolls 2D6
on the Determining Critical Hits table
(`src/rules/critical.ts`, `determiningResult`).

| 2D6 | Result |
| --- | --- |
| 2-7 | No critical hit |
| 8-9 | 1 critical hit |
| 10-11 | 2 critical hits |
| 12 | If the location is head / arm / leg, the limb is blown off; otherwise (torso) 3 critical hits |

For each critical hit, the player rolls the slot number:

| Location | Slot count | Procedure |
| --- | --- | --- |
| Head, legs | 6 | 1D6 → slot 1-6 |
| Torso, arms | 12 | 2D6 — first die 1-3 selects the top half (slots 1-6), 4-6 the bottom half (slots 7-12); second die 1-6 selects the slot within the half |

Empty slots, soak (endo steel / ferro-fibrous / CASE / CASE II / TSM / stealth
systems, TW pp.134-143) and already-destroyed slots re-roll. Unmodelled
equipment (ECM, probes, Artemis, MASC, ...) is hittable: the slot is
destroyed with no modelled effect (TW p.124). If the source location is exhausted (every crit-hittable
slot already destroyed) at the start of this determining, the whole roll
transfers to the next inward location per the standard damage-transfer
diagram; head and center torso are terminal. If the source still has
hittable slots, overflow is lost (excess crits simply disappear).

**Effects in this subset:**

- Weapon slot hit → that weapon is destroyed; multi-slot weapons are
  disabled by the first hit, additional slot hits only "soak".
- Ammo slot hit → explosion of `per-shot damage value × remaining shots`
  (AMS rounds and Narc pods count 2 per shot, TW p.130, p.139; the
  Heat Phase explosion uses the same value) applied directly to the bin
  location's internal structure (the armor pool is bypassed per the rules). The explosion drains IS, transfers
  inward to the next location's IS — overflow bypasses armor at every
  stop (TW p.125) — and any location that newly lost IS triggers a fresh
  determining roll recursively.
- Limb blown off (determining 12 on arm/leg) → the location's armor
  and IS are zeroed; the arm is removed from play. This also applies to a
  limb or head the same hit destroyed (house ruling, VISION.md §2.4): the
  limb still leaves a club token and stays salvageable. The leg case renders
  the unit immobile only when both legs AND both arms are gone (TW p.122);
  one leg destroyed leaves a standing 'Mech with 1 walking MP and no
  running MP, prone one-leg may turn 1 hexside/turn.
- Head blown off (determining 12 on head) or cockpit slot hit → 'Mech
  destroyed.
- Leg actuators (upper/lower/foot) and hip → mark the slots destroyed
  and reduce the unit's effective walking MP via `effectiveMovement`
  (`src/rules/critical.ts`): each leg actuator −1 walk; a hip hit on a
  leg halves walking on that leg (round up) and ignores the other
  actuator penalties on that leg.
- Jump-jet slot hit → −1 jump MP per destroyed slot.
- Engine, gyro, sensor, life-support slots → mark destroyed; a destroyed
  engine slot adds +5 heat per hit. Destroyed gyros/hips/leg actuators feed
   the piloting sweep (PSRs and automatic falls, TW p.60), a first destroyed
   sensor adds +2 to-hit and a second blinds the 'Mech (no weapon attacks),
   and a destroyed life support injures the pilot on hot
  heat phases (see "Piloting skill rolls" in `docs/CLI.md`) and, having
  lost the air supply, deals 1 pilot hit in each End Phase the 'Mech ends
  submerged (depth 2+ water, or prone in depth 1+; TW p.127).
- Heat-sink slot hits reduce end-phase dissipation: a destroyed single
  heat sink −1, a destroyed double heat sink retires the whole device
  (−2) once any slot of its run is destroyed.

Double heat sinks (DHS) appear in several `IS` 'Mechs (e.g. Hermes II,
Cicada, Mad Cat Mk II). A DHS device occupies 3 consecutive slots (Inner
Sphere) or 2 (Clan); the MTF `Heat Sinks` header fixes the type and total
count (engine mounts `floor(walking × tonnage / 25)` free). Destroying
one slot destroys the whole device: dissipation drops by 2 heat and the
sibling slots in the same run are marked destroyed by the resolver so
subsequent re-rolls don't hit them.
