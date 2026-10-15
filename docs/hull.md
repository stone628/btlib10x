# 'Mech hulls and wreckage for salvage: design

Checked against `btlib10x` at `9498b08b`. Design with all rule decisions settled
(2026-10-15); no code changed yet. §1-3 describe the current code and the rules; §4-7 are the
decided design.

## 1. What the code does today

| Area | Behaviour | Where |
|---|---|---|
| Who leaves a wreck | Manual eject, auto-eject (head lost or CT destroyed, if `autoEject` on), pilot killed by pilot hits | `resolveEjection` game.ts:5670, `removePilotKilled` game.ts:1183, `markUnitDestroyed` game.ts:1130, `resolveCenterTorsoBlast` game.ts:1562 |
| Who leaves nothing | Every other destruction (CT without auto-eject, 3 engine hits, cockpit crit, ammo explosion with auto-eject off). Unit removed, hex free | `markUnitDestroyed` game.ts:1153 |
| Wreck record | `state.wrecks["col,row"] = { unitId, level: 1 \| 2 }`. The unit keeps `removed = "pilotEjected" \| "pilotKilled"` and its damage | types.ts:92-113, game.ts:905 |
| Height | Level 1 if under 40 t or prone at removal, otherwise Level 2 | `wreckLevelFor` game.ts:1683 |
| Movement | Impassable and unlandable for everyone; charge into the hex is voided | `executeMove` game.ts:2024, `movement.ts:162-437`, game.ts:1752, 4501-4527 |
| LOS | Level 2 wreck between units blocks regardless of heights; Level 1 never blocks | `losBlockedByWreck` los.ts:272 |
| Partial cover | Any wreck adjacent to the target (even behind it): L2 +2, L1 +1, L2 +1 from above | `partialCoverDetail` game.ts:1061-1086 |
| Damage | Wreck cannot be targeted or damaged; it is permanent. Salvage value is frozen at the moment of abandonment | (no code path) |
| Victory | Counts as lost for its team | game.ts:5703 |
| Salvage today | Only severed limbs (`salvageableSeveredLimbs`, voided when picked up as a club), stranded ammo (`strandedShots`), crit flags kept on lost locations | game.ts:3015, ammo.ts:45, critical.ts:50-52, 640-651 |
| Web / AI | Rendered as an "ejected" unit marker; persona LOS uses `losClear`; autoplay ejects immobile prone units "so the wreck leaves play" | render.ts:53, persona.*.ts, autoplay.ts:59 |
| Text | Logs always say "level-2 wreck" | i18n/en.ts:104, 662, 772 (and ko.ts) |
| Docs | VISION §2.1 house rule; CLI.md:86, 253, 292-306; API.md:35, 362, 380, 767 | |

## 2. Why the current model is wrong

1. **Survival of the hull depends on the pilot, not the hull.** A CT-destroyed 'Mech leaves a
   wreck only if auto-eject was on; an intact 'Mech whose pilot ejected leaves the same wreck as
   a gutted one. For salvage the hull is what matters.
2. **A salvageable 'Mech is modelled as terrain.** It cannot be shot, so the most natural salvage
   decision in play (deny the enemy a recoverable hull) does not exist, and its value is frozen.
3. **Heights and effects are invented.** The L1/L2 split, the +2 cover and "L2 blocks LOS" are
   labelled TW/TO in comments and docs but appear in neither book. That is the source of the LOS
   bug you reported.
4. **Destroyed 'Mechs vanish**, so nothing of them is left for salvage on the board.

## 3. Rules anchors

- TW p.100: other units have no effect on LOS. TW p.102 partial cover comes only from terrain.
- TW p.110: immobile target (shut down / unconscious) −4 to-hit.
- TW p.128: destroyed units are removed at the end of the phase. Salvage note: if damage is
  tracked for salvage, a 'Mech standing at the start of the phase it was destroyed in takes an
  automatic fall.
- TO:AR p.155 Battlefield Wreckage: a destroyed unit of 40 t or more turns its hex into Rough
  (stacks with existing terrain; in water it changes the bottom, not the depth).
- TO:AR p.164-165: an ejected 'Mech is abandoned. Abandonment (no ejection): announce in an End
  Phase while the 'Mech is prone and shut down; in the End Phase of the next turn the MechWarrior
  steps out as if successfully ejected (no landing roll).
- TW p.60 (PSR table note): a shut-down 'Mech that must make a Piloting Skill Roll falls automatically.
  Voluntary shutdown forces no PSR.
- TO:AR p.184-185: an abandoned, not destroyed unit stays on the board as a neutral unit, can be
  damaged and destroyed, and others may move into and out of its hex subject to stacking.
  A 'Mech whose pilot ejected cannot be re-crewed in battle.

## 4. Model: two kinds of remains

| | Hull | Wreckage |
|---|---|---|
| Frame | Intact, pilot gone | Destroyed |
| Created by | Manual eject, auto-eject from an intact frame, pilot killed by pilot hits, voluntary abandonment | Any destruction of a 'Mech of 40 t or more, including a destroyed hull |
| On the board as | A neutral, shut-down unit | A terrain overlay (Rough) |
| Rules basis | TO:AR p.184-185 abandoned units; abandonment is a house rule (§4.2) | TO:AR p.155 Battlefield Wreckage |

### 4.1 Hull (abandoned, frame intact)

- **Stays a unit.** Keeps its record, team (for salvage ownership and stacking) and position; it
  no longer acts (no movement, attacks or heat choices). Implemented as the existing `removed =
  "pilotEjected" | "pilotKilled"` plus the new `"pilotAbandoned"`, and a new predicate
  `isUnitOnBoard` (on board and not destroyed), so the ~60 "can it act" checks keep using
  `isUnitAvailable` unchanged.
- **Posture.** Permanently shut down and immobile. It keeps the posture it was left in: ejection
  and pilot death leave it as it was at that moment; voluntary abandonment leaves it standing.
  A hull never makes a Piloting Skill Roll: any event that would call for one (20+ damage in a
  phase, leg or gyro loss, a kick or push) makes a standing hull fall automatically, with normal
  falling damage (TW p.60 table note). Standing hulls stay up until something knocks them over.
- **Targetable by both sides.** Weapon and physical attacks at the −4 immobile modifier (TW
  p.110), normal hit locations, crits and ammo explosions. Damage lowers salvage value. A
  destroyed hull becomes wreckage (§4.3).
- **Stacking and movement.** For movement the hull is a neutral unit (TO:AR p.184): it occupies
  its hex as a 'Mech for stacking, so
  - any unit of any team may move through the hex but not end movement there;
  - jumping over or through the hex is allowed as for any ground unit (TW p.58);
  - charge and DFA treat the hull as a normal target unit.
- **LOS and cover.** None, like any unit (TW p.100). `losBlockedByWreck`, the wreck branch of
  partial cover, `wreckLevelFor` and the `WRECK_*` constants are removed, and the reported LOS
  bug goes with them.
- **Victory.** Counts as lost for its team.
- **Why PSR-driven falls, not "falls when hit".** A hit alone never knocks a hull over; only the
  events that would force a PSR do. TW p.60 already says a shut-down 'Mech that must roll falls
  automatically, so this needs no new rule, and the same code path serves a shut-down 'Mech that
  is still waiting to be abandoned (§4.2). Falling on any hit would make a standing hull
  last only until the first shot, which defeats the purpose of standing abandonment.

### 4.2 Voluntary abandonment (house rule, adapted from TO:AR p.165)

TO requires a prone 'Mech; this keeps TO's shut-down-then-wait shape but lets the 'Mech stand,
so the pilot leaves unhurt and the hull stays upright.

1. **Turn N, shut down.** Voluntary shutdown in the movement phase (TW p.160, no PSR). The 'Mech
   is now a standing immobile target (−4) that cannot act for the rest of the turn.
2. **Turn N+1 or later, abandon.** If still shut down at its movement activation, the player
   declares `mode abandon` instead of any other action (restart included). The pilot leaves with
   no Piloting Skill Roll and no pilot hits; the unit becomes a standing hull at once
   (`removed = "pilotAbandoned"`). An active 'Mech cannot abandon in a single turn.
3. **Pilot survives** for campaign purposes, as an ejected pilot does today. Pilots are not
   placed on the map.
4. While shut down and waiting, normal rules apply: head hits still hurt the pilot, and a PSR
   while shut down is an automatic fall (TW p.60). Abandonment is risk-free only once declared.

Eject stays the emergency exit: usable any time, even while active, with the landing roll.

### 4.3 Wreckage (destroyed frame)

- The unit is removed from play at the end of the phase in which it was destroyed (TW p.128).
  Its record and damage stay in `state.units` for salvage reading.
- **Salvage fall (TW p.128).** A 'Mech destroyed in a phase it started standing takes an automatic
  fall: normal falling damage is applied to its record, and a pilot who survived by auto-eject
  takes the fall's pilot damage too. Resolved before the wreckage is placed.
- **Wreckage overlay**, per TO:AR p.155 as written:
  - only 'Mechs of **40 t or more** leave wreckage; lighter 'Mechs leave nothing on the board
    (their record is still kept for salvage);
  - the hex gains **Rough**: +1 MP to enter, no PSR, no to-hit modifier, no LOS effect
    (TW p.52, TO:AR p.30). Units enter, end movement and land there freely;
  - Rough is **added** to the hex's existing terrain (TW p.49 stacked terrain: light woods +
    wreckage = 3 MP); a hex that is already `rough`, or already has wreckage, does not change
    (a repeat type adds nothing; no Ultra Rough, no pile-up);
  - **water:** the wreckage lies on the bed; depth is unchanged and a 'Mech on the bed pays +1;
  - **buildings:** a 'Mech destroyed in a standing building hex records wreckage that costs
    nothing until the building collapses, then the hex is rubble + rough.
- Implemented as a yes/no overlay `state.wreckage: Record<hexKey, string[]>` (unit ids, for
  salvage reading), because `TerrainType` holds one value per hex and cannot express
  "light woods + rough". No new `TerrainType`.

### 4.4 Salvage readout

New `salvageReport(state)` listing every unit that is not operational at battle end: `hull` or
`wreckage`, removal reason (ejected / abandoned / pilot killed / destroyed), team, hex, posture,
damage, destroyed crit slots, stranded ammo and salvageable severed limbs. Who gets the salvage
(field control) stays with the campaign layer. Replay end-state lines already carry the damage,
so the replay format only needs the hull/wreckage tag.

## 5. Rough terrain reference

| Type | Source | MP | PSR to enter | To-hit | LOS | Used here |
|---|---|---|---|---|---|---|
| Rough | TW p.52, TO:AR p.30 | +1 | none | +0 | no effect | 'Mech wreckage |
| Ultra Rough | TO:AR p.30, p.37 | +2 | none | +0 | no effect | no |
| Rubble | TW p.52, TO:AR p.30 | +1 | yes (TW) | +0 | no effect | building collapse only |
| Ultra Rubble | TO:AR p.30, p.37 | +2 | yes, +1 | +0 | no effect | no |

The Battlefield Wreckage Table also gives Ultra Rough (large support vehicles, rail) and Ultra
Rubble (DropShips); neither applies to a 'Mechs-only engine.

## 6. Gameplay effects

- Shooting hulls is a real choice: spend fire to deny salvage, or keep shooting live threats.
  The AI persona should ignore hulls unless nothing live is in reach.
- The board stays open: no invisible LOS walls. Hulls shape movement by stacking (passable, but nobody
  can stop on it); wreckage slows ground by +1 MP.
- Ejecting is the emergency exit: it saves the pilot at the cost of a landing roll. Planned
  abandonment costs a shut-down turn but keeps the pilot unhurt and the hull standing, the most
  salvage-friendly outcome until the enemy knocks it over or wrecks it.
- Destroyed medium and heavier 'Mechs leave slow ground, which matters around chokepoints.

## 7. Implementation outline

1. **Hull model:** `isUnitOnBoard`; hull posture kept; PSR → automatic fall for hulls;
   targeting, occupancy and damage accept hulls; team-based pass-through; destroyed hull →
   wreckage. Remove wreck LOS/cover code. Tests: eject, piloting, snapshot, fireability,
   movement.
2. **Abandonment:** `abandonPilot` + `mode abandon` (shut-down precondition), `pilotAbandoned`
   removal reason, CLI help, i18n; autoplay switches its stuck-unit exit from eject to
   shutdown-then-abandon.
3. **Wreckage:** salvage fall on destruction; `state.wreckage` overlay; +1 MP in `movement.ts`
   with the no-repeat rule; building-collapse hand-off; snapshot save/load; map render glyph.
4. **Salvage report + web:** `salvageReport`, hull marker, i18n log lines (drop "level-2"),
   persona target filter.
5. **Docs:** VISION §2.1 rewritten (hull = TO:AR p.184, wreckage = TO:AR p.155, abandonment
   house rule, no house LOS rule), CLI.md, API.md, REPLAY.md (hull/wreckage tag), `build:web`.

Compatibility: `BattleState.wrecks` is replaced, so snapshots and old replay logs with
wreck-dependent moves or shots will drift. REPLAY.md already reports engine-version drift; no
migration is planned.
