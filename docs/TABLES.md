# Reference Tables

BattleTech numeric lookups used when designing or analyzing 'Mechs. Values are
Inner Sphere tabletop rules (Total Warfare / BattleMech Manual construction),
**not** the MechWarrior Online video-game adaptation, which scales numbers up
(among other changes). Note: the current engine (quick-start rules) tracks only
armor, so this internal-structure table is reference data, not yet modelled in
`src/`.

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
| 30 | 3 | 10 | 7 | 5 | 7 |
| 35 | 3 | 11 | 8 | 6 | 8 |
| 40 | 3 | 12 | 10 | 6 | 10 |
| 45 | 3 | 14 | 11 | 7 | 11 |
| 50 | 3 | 16 | 12 | 8 | 12 |
| 55 | 3 | 18 | 13 | 9 | 13 |
| 60 | 3 | 20 | 14 | 10 | 14 |
| 65 | 3 | 21 | 15 | 10 | 15 |
| 70 | 3 | 22 | 15 | 11 | 15 |
| 75 | 3 | 23 | 16 | 12 | 16 |
| 80 | 3 | 25 | 17 | 13 | 17 |
| 85 | 3 | 27 | 18 | 14 | 18 |
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
(outside quick-start scope).

### Armor limits

- **Maximum armor per location = 2 × its internal structure points** (e.g. an
  arm with 8 IS points may carry up to 16 armor points).
- The **head** maxes out at **9** armor points regardless of tonnage.

## Repo 'Mechs by tonnage

| Model | Name | Tonnage | CT | Side Torso | Arm | Leg |
| --- | --- | --- | --- | --- | --- | --- |
| CDA-3MA | Cicada | 40 | 12 | 10 | 6 | 10 |
| HER-5SA | Hermes II | 40 | 12 | 10 | 6 | 10 |
| ENF-4R | Enforcer | 50 | 16 | 12 | 8 | 12 |
| HBK-4G | Hunchback | 50 | 16 | 12 | 8 | 12 |
| GRF-1N | Griffin | 55 | 18 | 13 | 9 | 13 |
| WVR-6R | Wolverine | 55 | 18 | 13 | 9 | 13 |

(Each also carries 3 head points.)
