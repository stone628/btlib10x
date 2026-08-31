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

Classic Total Warfare arc classification (`src/rules/arcs.ts`, `classifyArc`),
measured as a **clockwise offset** from a unit's facing hexside. Front (0) and
rear (3) are one hexside wide; each side arc spans two hexsides. The engine
currently only fires into the **front** arc (side/rear firing is not yet
implemented), but all arcs drive hit-location selection and the rear armor
pool.

| Offset from facing | Arc | Hit-location table | Armor pool |
| --- | --- | --- | --- |
| 0 | front | Front / Rear | front |
| 1–2 | rightSide | Right side | front |
| 3 | rear | Front / Rear | rear (torso) |
| 4–5 | leftSide | Left side | front |

## Cluster Hits

Cluster Hits Tables (`src/rules/cluster.ts`). Each row is the 2D6 roll; entries
are the number of missiles (or rapid-fire shots) that hit. Missile columns are
the weapon's missile count; the shot columns are shots fired.

Missiles (columns: 2, 4, 5, 6, 10, 15, 20 missiles):

| Roll | 2 | 4 | 5 | 6 | 10 | 15 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 1 | 1 | 2 | 3 | 5 | 6 |
| 3 | 1 | 2 | 2 | 2 | 3 | 5 | 6 |
| 4 | 1 | 2 | 2 | 3 | 4 | 6 | 9 |
| 5 | 1 | 2 | 3 | 3 | 6 | 9 | 12 |
| 6 | 1 | 2 | 3 | 4 | 6 | 9 | 12 |
| 7 | 1 | 3 | 3 | 4 | 6 | 9 | 12 |
| 8 | 2 | 3 | 3 | 4 | 6 | 9 | 12 |
| 9 | 2 | 3 | 4 | 5 | 8 | 12 | 16 |
| 10 | 2 | 3 | 4 | 5 | 8 | 12 | 16 |
| 11 | 2 | 4 | 5 | 6 | 10 | 15 | 20 |
| 12 | 2 | 4 | 5 | 6 | 10 | 15 | 20 |

Rapid-fire / multi-shot (columns: 2, 3, 4 shots), for Ultra autocannons:

| Roll | 2 | 3 | 4 |
| --- | --- | --- | --- |
| 2 | 1 | 1 | 2 |
| 3 | 1 | 1 | 2 |
| 4 | 1 | 1 | 2 |
| 5 | 1 | 2 | 2 |
| 6 | 1 | 2 | 2 |
| 7 | 1 | 2 | 3 |
| 8 | 2 | 2 | 3 |
| 9 | 2 | 2 | 3 |
| 10 | 2 | 3 | 3 |
| 11 | 2 | 3 | 4 |
| 12 | 2 | 3 | 4 |

LRM missiles are applied in lots of **five**: a hit lot lands on one location
(e.g. an LRM-10 firing 8 hits produces lots of 5 and 3, each on its own
location).

## Critical Hits

Whenever a hit strips at least 1 point of internal structure from a
location, the player rolls 2D6 on the Determining Critical Hits table
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

Empty slots, soak (endo steel / CASE / ferro-fibrous) and already-destroyed
slots re-roll. If the source location is exhausted (every crit-hittable
slot already destroyed) at the start of this determining, the whole roll
transfers to the next inward location per the standard damage-transfer
diagram; head and center torso are terminal. If the source still has
hittable slots, overflow is lost (excess crits simply disappear).

**Effects in this subset:**

- Weapon slot hit → that weapon is destroyed; multi-slot weapons are
  disabled by the first hit, additional slot hits only "soak".
- Ammo slot hit → explosion of `per-shot damage value × remaining shots`
  applied directly to the bin location's internal structure (the armor
  pool is bypassed per the rules). The explosion drains IS, transfers
  inward, and any location that newly lost IS triggers a fresh
  determining roll recursively.
- Limb blown off (determining 12 on arm/leg) → the location's armor
  and IS are zeroed; the arm is removed from play, the leg renders the
  unit immobile.
- Head blown off (determining 12 on head) or cockpit slot hit → 'Mech
  destroyed.
- Leg actuators (upper/lower/foot) and hip → mark the slots destroyed
  and reduce the unit's effective walking MP via `effectiveMovement`
  (`src/rules/critical.ts`): each leg actuator −1 walk; a hip hit on a
  leg halves walking on that leg (round up) and ignores the other
  actuator penalties on that leg.
- Jump-jet slot hit → −1 jump MP per destroyed slot.
- Engine, gyro, sensor, life-support, single/double heat-sink slots →
  mark destroyed; the side-effects (heat, piloting rolls) are deferred
  with the rest of the heat / piloting subset.

Double heat sinks (DHS) appear in several `IS` 'Mechs (e.g. Hermes II,
Cicada, Mad Cat Mk II). Each DHS occupies a run of consecutive slots;
destroying one slot destroys the whole DHS, and the sibling slots in the
same run are marked destroyed by the resolver so subsequent re-rolls
don't hit them.
