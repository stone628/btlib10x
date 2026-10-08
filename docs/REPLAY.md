# REPLAY.md — compact battle replay format (draft)

Status: **draft, not implemented.** A replay is a log of the **engine API calls**
that drove a battle (`src/rules/game.ts`, `physical.ts`), plus the seed — not
CLI words. Re-running the calls on the same engine version with the same seeded
`Rng` (mulberry32, `web/rng.ts`) reproduces the battle; dice are never stored.
Terse on purpose — not meant to be read without this document.

Records are separated by `;` or `\n` (decoders accept both, mixed).

## Alphabets

| name | chars | meaning |
|---|---|---|
| idx | `0-9a-z` | unit index, **0-based** registration order (0..35 max) |
| wpn | `1-9a-z` | weapon number, **1-based** as in `fire` (`weaponIndex = n − 1`), 1..35 |
| slot | `1-9abc` | crit slot number, **1-based** as on `sheet` |
| dir | `n m d s a b` | `Facing` as keyboard letters: `n` north, `m` north-east, `d` south-east, `s` south, `a` south-west, `b` north-west (`b n m` and `a s d` read west to east) |
| loc | `h C R L a A g G` | `LOC_CODES` in `src/data/mech.codec.ts` (head, CT, RT, LT, RA, LA, RL, LL). Rear codes `c r l` are unused: torsos carry rear inline |
| hex | `ccrr` | 1-based col, row, two digits each (`0504` = col 5, row 4), as `HexCoord`; only unit start positions use it, moves are relative |

`LOC_CODES` is module-private today; export it plus a canonical order
`hCRLaAgG` when implementing.

Runs of **4+ consecutive** wpn chars compress with `~` (`1~4`); 3 or fewer stay
spelled out (`123`).

## Records

```
V<engineVer>                      engine version stamp (`ver`, YYMMDD-hash)
B<map>                            map (battlefield) name
S<n>                              seed, always explicit; setup only (before the first `M`)
K                                 CreateBattleOptions.critsDisabled = true (omit normally)
U<team><id>:<model>:<place>[:<armor>[:<crit>[:<ammo>[:<policy>]]]]    unit registration (setup only)
M<move>                           one movement activation (one unit), in activation order
A<attack>                         one attack activation (one unit), in activation order
W<teamId><rng>                    winner: team still standing (`W-` = nobody) + final Rng state; ends play
E<idx><hits>[:<armor>[:<crit>[:<ammo>]]]    final state per unit, idx order
```

- **No start record.** The first `M` implies `createBattle(map, units, options)`
  plus the initiative roll; `U`, `B`, `K` after it (an `S` is still legal)
  are errors.
- The seed is never defaulted: a replay without an `S` record is invalid.
- Every record starts with an uppercase command char. Within `M` and `A` lines (and unit fields) the same letters mean something else; the first char of a line always selects the record.
- Trailing empty `:` fields are dropped; a middle empty field keeps its `:`.
- One `M` / `A` line per activation. Phase and turn boundaries are not marked: a run of `M` lines is a movement phase, the following `A` lines its attack phase, and the next `M` starts the next turn. The decoder knows where each phase ends (every living unit has acted). Phase transitions, initiative rolls and
  `resolveAllAttacks` are **not** recorded: the decoder drives them exactly as the
  session does (`gameLoop` with the victory stopper) after every activation.
- Each entry's `<idx>` is redundant with `nextActor(state)`; the decoder
  **asserts** equality, which catches order drift early.
- Only **successful commits** are recorded. A rejected command rolls back battle
  and Rng (`commitAtomic`), so it leaves no trace; a failed stand-up roll is a
  successful commit and is recorded normally.

### `U` — unit registration (→ extended `UnitInit`)

`U0hunchy:HBK-4G:0503s456:C26/1/1A16/2:a3a4:L13L22:s`

| part | meaning |
|---|---|
| `U0` | `team` 0..9 |
| `hunchy` | unit `id` (up to the first `:`; no `:` `,` `;` in names) |
| `HBK-4G` | `model`, must exist in the catalog |
| `0503s456` | `position` `0503`, `facing` `s`, `gunnery` `4`, `piloting` `5`, `pilotHitMax` `6`; optional 9th digit = `pilotHits` (omit = 0) |
| armor | damage **taken** per location vs model default, see below |
| crit | destroyed crit slots: `<loc><slot>` repeated (`a3a4` = right arm slots 3, 4) |
| ammo | shots **used**: `<loc><slot><n>` repeated (`L13L22` = LT slot 1 used 3, LT slot 2 used 2); `n` is decimal, runs to the next letter |
| policy | this unit's ammo policy, one char: `e` exposed / `c` core / `s` spread / `l` leastFirst. Omit the field when it is the default (`e`) |

Index = registration order (first `U` is `0`). Ammo policy is **setup-only** (`UnitInit.policy`, edited with `set <id> ammoPolicy <policy>`); the
attack phase has no ammo command or policy item. `set`/`rm` edits made during setup are not
recorded — only the final roster is.

Starting damage is `UnitInit.damage?: UnitInitDamage` (`src/rules/initialDamage.ts`),
applied and validated by `createBattle`; there is no post-hoc patching. Jams are
transient and are **not** part of starting damage (`jammedWeapons` always starts empty).

```ts
interface UnitInitDamage {
  pilotHits?: number;
  damageTaken?: { armor?: Partial<LocationValue>; armorRear?: Partial<TorsoLocationValue>;
                  internalStructure?: Partial<LocationValue> };   // damage TAKEN, not remaining
  critsDestroyed?: Partial<Record<Location, number[]>>;          // 1-based slot numbers
  ammoUsed?: Record<AmmoBinId, number>;                          // shots used per bin
}
// UnitInit.policy: UnitPolicy ({ ammoPolicy }) is separate and always present
```

`createBattle` sets `baseDamage` / `baseCritSlotsDestroyed` to clones of the starting
state (so the first turn raises no piloting rolls for it) and derives
`destroyedWeapons` (any destroyed slot of a mount) and empties destroyed ammo bins.
A unit with a destroyed leg or gyro starts **prone** (TW p.122, crit table gyro row).

#### armor field → `UnitDamageState`

- Non-torso (`h a A g G`): `<loc><armorLost>[/<internalLost>]` — `A16/2`.
- Torso (`C R L`): `<loc><frontLost>[/<rearLost>[/<internalLost>]]` — `C26/1/1`. Empty middle allowed: `L15//10`.
- Missing trailing values = 0. Locations in canonical order `hCRLaAgG`, each at most once; untouched locations omitted.
- Maps 1:1 onto `damage.armor` / `armorRear` / `internalStructure` (default minus value).

#### validation (in `createBattle`, against `MechDef` + tables)

Consistency (each failure throws `Starting damage for <id>: …`):

- `|gunnery − piloting| ≤ 2` (TW p.273); unique ids; ≥ 2 units on ≥ 2 teams.
- armor lost ≤ model armor per pool; internal lost ≤ model internal structure; no negatives.
- internal lost > 0 requires the location's armor depleted (torso: front **or** rear pool); a destroyed side torso needs its arm destroyed too (mirrors `applyDamage`).
- crit slot exists in `critSlots[loc]`, is not `empty`, and is not listed twice (a double heat sink dies as a whole group).
- ammo: key is an existing bin; used ≤ the bin's loaded shots.
- hex inside the map, not occupied.

Gates — states that would already be out of play are rejected as `unit would start destroyed (<reason>)`, using the same counters the runtime uses:

- `headDestroyed` (head structure gone), `centerTorsoDestroyed`, `cockpitDestroyed` (a destroyed cockpit slot), `engineDestroyed` (3 engine slots destroyed, counting those lost with a destroyed side torso on XL engines);
- pilot dead (`pilotHits ≥ pilotHitMax`).

Crippled-but-alive states (destroyed gyro, blinded sensors, both legs, no arms) are legal.

### `M` — movement entries (→ posture calls + `executeMove`)

Line: `M<idx><op>[args]` (one actor).

| op | engine call(s) | args |
|---|---|---|
| `s` `w` `r` `j` | `executeMove(mode, steps, {finalFacing})`, mode standStill / walk / run / jump | `[steps][facing]` |
| `U<s\|w\|r>` | `attemptStandUp(locomotion)` (standStill / walk / run), then — only if now upright and steps or facing given — `executeMove(locomotion, steps, {finalFacing, spentMP, modeHeatPaid})` | `[steps][facing]` |
| `D` | `dropProne`, then — if steps or facing given — `executeMove("walk", steps, {finalFacing, spentMP: DROP_MP_COST})` | `[steps][facing]` |
| `X` | `voluntaryShutdown` | – |
| `O` | `attemptVoluntaryStartup` | – |
| `E` | `ejectPilot` | – |
| `.` | `passMovement` (also what the session does when a shut-down or unconscious unit commits) | – |

`steps` are relative to the actor's hex and heading when the move starts, one character each:

| char | meaning | engine step |
|---|---|---|
| `>` / `<` | turn right / left one hexside | `turn` +1 / −1 (ground), or a free re-aim of the travel direction (jump, no engine step) |
| `+` | step forward (the hex ahead of the current heading) | `enter` |
| `-` | step backward (the hex behind) | `enter` |

`facing` is one optional trailing letter, the `finalFacing` option (jump landing
facing, stand-up free facing). It needs no prefix: a letter can only follow the
steps (`U<loco>` has a fixed one-char locomotion and no other op takes an
argument first), and the step characters share nothing with the facing letters.
`s` as an op (standstill) is always the char right after the unit index, so it
never collides with `s` as a facing.

On the ground the engine only allows the hex ahead or behind, so `+`, `-` and the
turns say everything. A jump may enter any neighbour: re-aim with `<`/`>` (free),
then `+` (or `-` for the hex exactly behind); the replayer must not turn those
re-aims into engine turn steps. Prone turning is `w` with `<`/`>` only; staying
prone is `s`.

Examples (clear map, north is row − 1): walk two hexes straight `M0w++`; one back
`M0w-`; half turn in place `M0w>>>`; run from (5,7) facing north to (6,4)
`M0r>+<++`; jump three north landing south-east `M0j+++d`; stand up in place
facing south `M0Uss` (`U`, locomotion `s`, facing `s`).

### `A` — attack entries (→ `declareAttacks` / `declarePickup`)

```
A<idx><F|L|R>[-|+[<src>][<tok>]]{:<tgt><item>...}
```

`A1F:01~4Q:2123L` = unit 1, torso front; at unit 0: weapons 1–4 and a right punch; at unit 2: weapons 1,2,3 and a right kick.

**Header** `<idx><twist>` is always written: `F` front (`options.twist` null), `L` leftSide, `R` rightSide. Optional after it:

| part | engine field |
|---|---|
| `-` | `options.dropClub` (may be followed by target groups) |
| `+[l\|t\|g][digit]` | `declarePickup(decl)`: source `l` limb / `t` tree / `g` girder (omit = auto), then optional `tokenIndex`. Exclusive: no target groups, nothing else after it in the entry |

**Target group** `:<tgt><item>...` — `:` opens a group, the next char is the target idx, then items until the next `:` or the end of the line. Items:

| item | engine field |
|---|---|
| weapon chars `1-9a-z`, `~` runs | `WeaponAttackDecl {weaponIndex, targetId}` per weapon; `!` after a weapon char sets `rapidFire` (`3!`; no `~` across `!`) |
| `P` / `Q` | punch, `limb` leftArm / rightArm |
| `K` / `L` | kick, `limb` leftLeg / rightLeg |
| `U` | push (no limb) |
| `C` | club (no limb) |
| `S<w>` / `T<w>` | strike, `limb` leftArm / rightArm (mounting arm); `w` = `weapon` `h` Hatchet / `s` Sword / `b` Retractable Blade. Both are written because `PhysicalAttackDecl` carries both; the decoder validates the pair against the mounts (`resolveStrikeMount`) |

The engine accepts several target groups per line (multiple targets, TW p.108). The primary target is not
recorded: replay uses the engine default (first target, or the first forward-arc target).

One actor per line, so no actor separator is needed. Physical items keep declaration order; two punches
(`P` and `Q`) may appear. The engine's own rules (one physical type per turn,
arm/leg conflicts with fired weapons, club bars arm weapons) are enforced by
`declareAttacks`, not by the format.

**No attack** is the bare header: `A1F` (pass, `passedAttacks = true`). `A1F-` is a
drop-only activation.

### `E` — final state (checksum)

`E<idx><hits>` (after `W`) + armor / crit / ammo in the same notation as `U`, cumulative
vs. model default (starting damage included). The policy field is setup-only and is not repeated here.
Replaying and diffing against it detects engine-version drift. Dead/removed units
need no flag (`destroyed` follows from the structure).

### `W` — rng state

`<rng>` is the mulberry32 state as exactly 8 lowercase hex digits (`W03f9a41c7` = team 0, state `3f9a41c7`; `W-3f9a41c7` = nobody left). It is the single `uint32` behind `createRng` in `web/rng.ts`, read with `rng.snapshot()`. Note `snapshot()` currently prints the raw signed int (`a.toString(16)` can start with `-`), so the encoder must normalize: `(a >>> 0).toString(16).padStart(8, "0")`, and the decoder compares as unsigned. The state is a cumulative fingerprint of every d6 drawn, so it catches any drift in dice consumption (an extra or missing roll anywhere) even when the `E` blocks happen to agree.

## CLI coverage

Every CLI command and where it lands. "UI" = no effect on battle state, never recorded.

| CLI command | replay |
|---|---|
| `help` `?` `lang` `board` `clear` `log` `info …` `table` `ver` `status` `sheet` `heat` `candidate` | UI only. (`ver` supplies the `V` record) |
| `autoplay` | UI only; the commands it types are recorded like any others |
| `seed <n>` | `S<n>` (always written, including the default 42) |
| `map <name>` | `B<name>` |
| `add` / `set` / `rm` | folded into the final `U` records (id, model, team, col, row, facing, gunnery, piloting, pilotHitMax, plus starting damage and ammo policy) |
| `start` | implicit at the first `M` |
| `reset` / `rematch` | not recorded; a replay is one battle. A rematch is a new replay with the same `v m s k u` header |
| `mode standstill\|walk\|run\|jump` + `place` + `done` | `s` `w` `r` `j` + steps + facing letter |
| `mode standup [walk\|run\|standstill]` + `place` + `done` | `Uw` `Ur` `Us` + steps |
| `mode prone [turn\|pronestill]` + `place` + `done` | `D` + turn steps (or bare `D` for `pronestill` / no place) |
| `mode turn` + `place` + `done` | `w` + turn steps |
| `mode pronestill` + `done` | `s` |
| `mode shutdown` / `startup` / `eject` + `done` | `X` / `O` / `E` |
| `done` with nothing declared in movement (pass) | `.` |
| `cancel` | not recorded (pre-commit) |
| `set <id> ammoPolicy <policy>` | setup only: the `U` policy field (`e` `c` `s` `l`); the attack-phase `ammo` command no longer exists |
| `torso <front\|left\|right>` | header char `F` `L` `R` (always written) |
| `fire <tgt> <weapons…>` + `done` | `:<tgt><wpns>`, `!` for rapid-fire |
| `punch <tgt> [left\|right]` | `P` / `Q` (default right = `Q`; limb is always written) |
| `kick <tgt> [left\|right]` | `K` / `L` |
| `push` `club` | `U` `C` |
| `strike <tgt> [left\|right]` | `S` / `T` + weapon char (the CLI's resolved arm and weapon are recorded) |
| `pickup [limb\|tree\|girder] [n]` | header `+[l\|t\|g][n]` |
| `drop` | header `-` (no groups = drop-only activation) |
| `done` with nothing declared in attack (pass) | bare header, e.g. `A1F` |

## Example

Illustrative, hand-written (not engine-generated): HBK-4G `hunchy` (team 0,
starts damaged, spread ammo policy) vs CDA-3MA `cicada` (team 1, gunnery 3).

```
V261008-8211edb
Bquickstart
S42
U0hunchy:HBK-4G:0503s456:C26/1/1A16/2:a3a4:L13L22:s
U1cicada:CDA-3MA:0508n356
M1r++
M0w+
A1L:01~4
A0F:1124
M0s
M1w+
A0F:11~4
A1F:0Q
M1s
M0s
A1F:01~4
A0F:11~4
W03f9a41c7
E01:h5C26/4/1A16/2:a3a4:L16L22
E10:C17/6/12L15//10:L4L5
```

One line:

```
V261008-8211edb;Bquickstart;S42;U0hunchy:HBK-4G:0503s456:C26/1/1A16/2:a3a4:L13L22:s;U1cicada:CDA-3MA:0508n356;M1r++;M0w+;A1L:01~4;A0F:1124;M0s;M1w+;A0F:11~4;A1F:0Q;M1s;M0s;A1F:01~4;A0F:11~4;W03f9a41c7;E01:h5C26/4/1A16/2:a3a4:L16L22
E10:C17/6/12L15//10:L4L5
```

Decode notes:

- `U0hunchy…`: unit 0, team 0, at (5,3) facing south (`s`), gunnery 4 / piloting 5 / hit max 6; CT front −26 (gone), rear −1, internal −1; left arm armor −16 (gone), internal −2; right-arm slots 3,4 destroyed; LT ammo slot 1 used 3 shots, slot 2 used 2; spread ammo policy (`s`). `U1cicada` has no armor/crit/ammo/policy fields: undamaged, default policy.
- `M1r++` / `M0w+`: unit 1 (at (5,8), facing north) `executeMove("run", [enter 5,7; enter 5,6])`, then unit 0 (at (5,3), facing south) `executeMove("walk", [enter 5,4])`. The first `M` also creates the battle.
- `A1L:01~4` / `A0F:1124`: unit 1 twists left and fires weapons 1–4 at unit 0; unit 0 (front) fires weapons 1,2,4 at unit 1.
- `A0F:11~4` / `A1F:0Q`: unit 0 fires weapons 1–4 at unit 1; unit 1 right-punches unit 0.
- `W03f9a41c7`: team 0 is the last one standing; the Rng ended in state `0x3f9a41c7` (illustrative value). `E10:…`: unit 1, 0 pilot hits, CT internal −12 (full) ⇒ destroyed.
- Other shapes: `A1F` pass · `A1F-:01~4` drop club then fire · `A1F+t` pick up a tree · `A2R:0Ts:1P` unit 2 twisted right: right-arm strike with a Sword at unit 0, left punch at unit 1.

## Display layout

Records are separated by `;` or a newline, so a replay can be laid out either way.
The web CLI shows it as (`replayPrettifier` in `web/replay.ts`):

```
V261008-8211edb
Bquickstart;S42
U0hunchy:HBK-4G:0503s456:C26/1/1A16/2:a3a4:L13L22:s
U1cicada:CDA-3MA:0508n356
M1r++;M0w+
A1L:01~4;A0F:1124
M0s;M1w+
A0F:11~4;A1F:0Q
W03f9a41c7
E01:h5C26/4/1A16/2:a3a4:L16L22
E10:C17/6/12L15//10:L4L5
```

version alone · setup records other than units on one line · one line per unit · per
turn a movement line and an attack line · the winner line · one line per unit's end state.

## Implementation status

Recording, display and a verifying player exist in the web CLI (`web/replay.ts`).
`replayPlayer(text)` accepts raw or prettified text, rebuilds the battle from the
header and `U` lines, re-runs every `M`/`A` activation through the engine API on the
seeded dice, stops at `W` (winner and final Rng state must match) and compares each
unit's state with its `E` line. It returns nothing and prints nothing; the first
problem throws `replay failed at turn T, <phase> phase, actor <id>: <why> [record: …]`.
A version mismatch is not an error by itself, but is named in the message when
something else fails. Notes that came out of implementing the recorder:

- Entries are built from the session's pending declarations (`MovementContext`,
  `AttackContext`) and pushed at the top of the `commitAtomic` closure; `commitAtomic`
  truncates the log on failure, so rejected commands leave nothing.
- `S` is written from `setup.seed`. The seed can only be set in setup (`setSeed` and
  the `seed` command refuse once a battle has started), so there is exactly one `S`.
- A recording is only valid if the battle started from a fresh generator for that
  seed. `reset` re-creates the generator; a session whose generator was replaced is
  marked unrecordable and shows nothing.
- Weapon order inside an `A` group is the declaration order (it decides ammo
  priority) and is never sorted.
- Strike pairs are recorded as the CLI resolved them (arm + weapon).

## Implementation sketch

`src/rules/replay.ts` — pure `encode(calls) → string`, `decode(text) → calls`,
`diffFromDefault(unit, def)`, and a `run(calls)` that reproduces the session's
orchestration (posture + `executeMove` glue, `gameLoop` driver). A recorder in the
`commitAtomic` success paths of `web/session.move.ts` / `session.attack.ts` emits
the calls. Plus the `UnitInit` extension above. Round-trip test: seeded autoplay
battle → encode → replay → byte-equal `E` block. No Node-only APIs.

## Open items

- Exact `UnitInit` extension shape (above is a proposal).
- `W` is a checksum: the decoder runs the session victory check after each activation and asserts it first reports the recorded team (`W-` when no team survives), and that the Rng state matches `<rng>`.
