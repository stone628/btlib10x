# Gameplay Review — btlib10x terminal (https://bt10x.stoneworks.dev)

*Played 2026-09-01 in Chrome. One full battle to victory (63 turns), plus the built-in `autoplay` demo and a validation pass on setup input.*

## What I played

Seed 1337, map `quickstart` (15×16), 2v2:

| Unit | Model | Team | Gunnery |
|---|---|---|---|
| HBK | Hunchback HBK-4G | 0 | Regular (4) |
| GRF | Griffin GRF-1N | 0 | Veteran (3) |
| TW | Mad Cat / Timber Wolf TW-Prime | 1 | Veteran (3) |
| WVR | Wolverine WVR-6R | 1 | Regular (4) |

**Result:** team 0 won on turn 63. GRF and TW died in the turn 1–3 exchange; the last two units then spent ~50 turns with no line of sight until I walked the Wolverine into the Hunchback's face and it ate an AC/20 at range 1.

## Verdict

This is a genuinely faithful and well-built implementation. The rules are right, the output is legible, and the CLI is thoughtfully designed. The defects I found are peripheral — one input-validation hole and one log-rendering bug — not rules errors.

## What works well

**The rules are correct.** Every check I ran matched tabletop BattleTech:

- **Facing discipline.** `move 8 7` from a north-facing 'Mech was rejected: `Ground moves must go straight ahead or straight back relative to facing`. You must spend MP on `face` to turn. Correct, and the error teaches the rule.
- **MP costs.** Light woods 2, heavy woods 3, clear 1. I initially thought heavy woods was undercharged, but `terrainMoveCost` returns the *surcharge* over a base of 1 (`clear: 0, light: 1, heavy: 2`), and the totals in play were right. A `face` from n to s cost 3 MP — three hexsides. Correct.
- **To-hit stack is fully itemized.** `Need 6 (gunnery 3 + move 2 + target 1)`, `Need 9 (gunnery 4 + move 2 + target 1 + range 2)`. Every modifier is named and signed. Pulse lasers correctly produced `Need auto (gunnery 3 + move 1 + pulse -2)` → total 2 → auto-hit.
- **Cluster weapons.** CL LRM 20, cluster roll 6 → 12 missiles applied as `CT(5) RT(5) RT(2)` — correct grouping in 5s.
- **Damage → internal → critical chain.** `LTA 3->0*, LTI 13->6` then `crit roll 2D6 = 8 (1 critical hit) / LT #1 jumpJet destroyed`. The `*` marker for stripped armor is a nice touch.
- **Simultaneous resolution.** Attacks are declared per unit, then all resolve at once at phase end — correct, and it makes the alternating declaration order meaningful.
- **Alternating activation.** Initiative loser moves first, one unit at a time, alternating teams. Verified across both movement and attack phases.
- **Critical slot layouts are canonical.** The Griffin's expanded crit chart showed shoulder/upper-arm/lower-arm/hand actuators, PPC in 3 RA slots, LRM 10 + ammo in RT, engine/gyro in CT, jump jets in side torsos. That is the real GRF-1N sheet.

**The fire-suggestion hint is the standout feature.** On entering the attack phase you automatically get every target, its range, and a per-weapon table of location, range bracket, target number, damage and ammo — plus explicit reasons for unavailable weapons (`blocked: #2 CL ER Large Laser — no line of sight`, `blocked: #6 Medium Laser — destroyed`). It removes nearly all the bookkeeping that makes BattleTech slow, without making decisions for you.

**The board renders well.** A real ASCII hex grid with per-hex coordinates, elevation digits, colored terrain (`w`/`W`), and colored unit IDs. `mode run` overlays reachable hexes with `<>` markers and crops the view to the reachable region — genuinely useful for planning.

**The record sheet is laid out in 'Mech silhouette shape** — head on top, RA/RT/CT/LT/LA in a row, legs below — with internal/front/rear values per location and a collapsible crit chart. Clicking the summary works, and the `.no-prompt-focus` guard means it doesn't steal focus from the prompt.

**Determinism holds.** After a full 63-turn battle, `reset` → `seed 1337` → same roster → `start` reproduced the opening initiative exactly (team 0: 9, team 1: 5).

**Input validation is mostly solid.** Correctly rejected: duplicate unit ids, unknown models (`Unknown 'Mech model: ZZZ-9Q (try 'info mech')`), gunnery outside 0–7, `col` < 1, stacking two units in one hex, starting with fewer than two units, and starting with all units on one team. Error messages name the fix.

**Korean localization is complete and idiomatic**, not machine-translated filler.

## Bugs and rough edges

### 1. Units can be placed off the map (real bug)

On the 7×7 `test` map:

```
setup > add A AS7-D 0 4 99 99 n
A (AS7-D) placed at (99,99) facing n
```

The lower bound is checked (`add D GRF-1N 1 4 0 3 n` → `col is 1-based and must be >= 1`) but the upper bound against map width/height is not. The map *schema* validator does bounds-check terrain hexes, so the check exists — it just isn't applied to unit placement.

**Impact is a soft-lock, not cosmetic.** The battle starts normally, the off-map unit doesn't render on the board, and it can't be reached or shot. Its team can never be eliminated, so the game can never end. I verified the unit was absent from the rendered board while its opponent was present.

**Fix:** validate `col <= width && row <= height` in `addUnit` (or in `createBattle`, alongside the existing duplicate-id and model checks).

### 2. Every critical hit is logged twice

Each crit appears once correctly nested under the hit that caused it, and once orphaned at top level *before* its cause:

```
=== attack damage resolved ===
crit roll 2D6 = 8 (1 critical hit)
  LL #4 footActuator destroyed
=== resolving declared attacks ===
[AT -> WVR] Autocannon/20: ... 2D6 = 7 -> HIT
            hits: LL(20)
              LLA 11->0*, LLI 13->4
              crit roll 2D6 = 8 (1 critical hit)
                LL #4 footActuator destroyed
```

Counted across a full scrollback: **14 top-level crit lines, 14 indented crit lines** — an exact 1:1 pairing, and the roll and result match in each pair. Observed independently in my manual game and in `autoplay`.

The same fault splits the resolution block: a single attack phase emits several `=== resolving declared attacks ===` / `=== attack damage resolved ===` delimiter pairs (18 of each across ~6 autoplay turns), because the stream re-opens after each stray crit event. Reads as though damage resolved twice.

**Likely cause:** the formatter renders `criticalHit` events both as top-level log entries and as nested children of the damage event.

### 3. `weapons` is unavailable during movement

```
turn(1):move(team 1, mech TW) > weapons
error: unknown command 'weapons' (try 'help')
```

Movement is exactly when you need to know your ranges. `sheet <id>` and `info mech` partly cover it, but neither shows the live per-weapon range brackets in the format `weapons` gives. Adding `weapons` to `MOVE_CMDS` costs nothing — it is read-only.

### 4. `done` with an empty move silently forfeits

I mistyped a sequence, every step was rejected, and `done` committed anyway: `HBK walk -> 4,13 facing n, used 0 of 6 MP`. A turn was lost with no warning. The attack phase handles the equivalent case gracefully (`HBK is not attacking this turn.`), so movement should at least confirm — or say plainly that the unit is standing still.

### 5. `sheet` with no id omits damage

The roster list gives id, model, position and facing only:

```
team 0:
  HBK  HBK-4G  4,12 facing n
```

There is no at-a-glance health. You must run `sheet <id>` per unit to see whether anything is hurt. The end-of-battle `status` proves the compact form exists — it prints `armor: HD 9/9 | CT 26/26 | RT 20/20 | ...` with `!` marking breached locations. That line belongs in the in-battle list.

### 6. Ammo display is inconsistent across shared bins

In the Timber Wolf's weapon table, `#1 CL Machine Gun` showed `ammo 200` while `#8 CL Machine Gun` showed blank; `#5 CL LRM 20` showed `ammo 11` while `#9 CL LRM 20` showed blank. Paired weapons drawing from one bin render as though the second has no ammo at all.

### 7. Smaller items

- **Grammar:** `can use 8 movement point` — should be *points*. Appears on every `mode` command.
- **Stale Korean string:** the KR help for `info` reads `'메크 모델 또는 내장 맵 조회` ("'Mech models or bundled maps") but the EN version is `look up 'Mech models, bundled maps, or weapons`. The KR text is missing weapons and predates the feature.
- **Untranslated prompt:** the prompt stays English under `lang kr` (`over(team 0 won, total turn 63) >`), as does the phase name in `--- 단계 명령(over) ---`.
- **No turn limit or stalemate detection.** My last two units sat 5 hexes apart with no LOS for ~50 turns; nothing nudged, warned, or offered a draw. With standstill this can run forever.
- **Layout:** the board occupies roughly the left 40% of a 1120px viewport with the rest empty. Not wrong, just unused space.

## Priorities

| # | Issue | Severity |
|---|---|---|
| 1 | Off-map placement → unwinnable battle | **High** — corrupts game state |
| 2 | Duplicate crit logging / split resolution blocks | **Medium** — misleads on damage dealt |
| 3 | `weapons` missing in movement phase | Medium — usability |
| 4 | Empty `done` silently forfeits movement | Low–Medium |
| 5 | No damage in roster listing | Low |
| 6 | Shared-bin ammo display | Low |
| 7 | Grammar, stale KR string, untranslated prompt | Low |

## Overall

The engine is the strong part and it is strong: correct rules, transparent dice, faithful data, deterministic replay. The CLI design is better than it needed to be — phase-scoped commands, argument-level help, and the fire-suggestion hint in particular make a famously fiddly game playable at speed. Fix the placement bounds check and the duplicate crit log and there's very little left to complain about.
