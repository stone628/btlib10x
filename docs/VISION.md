# btlib10x Vision

This document states direction only. Rule-by-rule implementation status,
the public API, reference tables, usage and record-sheet authoring are
documented separately.

## 1. Goal: a simulator, not a game

- **Engine.** `btlib10x` is a zero-dependency TypeScript library that simulates
  BattleTech for **bipedal 'Mechs only**. It is deterministic given an injected
  `Rng`, mutates one serializable `BattleState` in place on a single thread,
  and snapshots to plain JSON. The engine never decides a winner: the caller
  owns the stop condition, and `scoreReport` gives it a read-only Battle
  Value score to decide from. Atomicity holds at the caller's commit
  boundary (e.g. snapshot and roll back), not per rule call.
- **Rules principle.** The engine implements *Total Warfare* (TW) as written
  wherever it can. It adopts a *Tactical Operations* (TO) rule only where TW
  leaves a gap the simulation needs filled. Where a rule is too deep or fiddly
  to pay for itself in play, or asks a player for a choice the simulator must
  make on its own, the engine follows an explicit **policy** instead (the
  per-unit policies of §2.2 are the model). Every such departure is listed in §2;
  anything not listed there follows TW.
- **Web CLI.** A single-page terminal-emulator app answers one question: how
  would this engine be used once playability counts? It exposes everything
  the engine simulates and nothing more. Vanilla TypeScript + DOM, zero
  runtime dependencies, browser-first (no Node-only APIs in the engine).
- **Later.** Once the engine is mature it becomes the backbone of a
  roguelike mercenary-management game: a stranded unit in debt, a stable as
  your company, every bout matters, real TW rules with no simplified combat
  model, standalone browser play. That game is out of scope here; this project
  tracks no mechanics, budgets or schedules for it.

## 2. Rules different from TW

Baseline: *Total Warfare*, 11th printing, bipedal 'Mechs. Every rule not
listed below follows TW as written. A TW rule that is simply not implemented
yet is a gap, not a deviation; gaps are tracked in §4.

### 2.1 Tactical Operations adoptions

- **Ejection and auto-eject (TO:AR p.165).** Manual ejection, plus auto-eject
  (on by default, per-unit opt-out) when the head is lost or the center
  torso is destroyed by an explosion. A center torso whose structure is
  simply shot out collapses with the pilot aboard and alive. A cockpit-slot
  kill still kills the pilot (no eject). The pilot's fate reads the frame,
  not the first kill rolled: a cockpit slot lost kills, else a lost head
  ejects (or kills), whatever other kill landed in the same step. Eject
  comes first: a head loss sets the pilot to one hit short of death
  "regardless of prior condition", absorbing that step's other pilot hits,
  and an ejected pilot takes only the ejection roll and blast feedback.
  Whether the system is armed is the `autoEject` policy (§2.2); disarmed,
  those losses kill the MechWarrior (TW p.128).
  *Why:* TW gives a doomed pilot no way out, and ejection is what turns a
  fight into salvage. *Not adopted:* planetary-condition modifiers and the
  submerged-cockpit ban.
- **Hulls: abandoned 'Mechs (TO:AR pp.184–185).** A 'Mech whose pilot ejects,
  is killed or abandons it, with its frame intact, stays on the board as a
  neutral, permanently shut-down hull in the posture it was left in. Both
  sides may target it (−4 immobile, TW p.110); any unit may move or jump
  through its hex but none may end movement there; charges and DFAs treat it
  as a target. It never rolls a PSR: an event that would call for one drops
  it automatically (TW p.60). Like any unit it has no LOS or cover effect
  (TW pp.100, 102). It counts as lost for its team. Destroyed, it becomes
  wreckage. *Why:* the hull is what salvage is about, so deciding whether to
  spend fire denying it to the enemy is a real choice.
- **Battlefield wreckage (TO:AR p.155).** A destroyed 'Mech of 40 t or more
  turns its hex into Rough stacked on the existing terrain (+1 MP; no PSR,
  to-hit or LOS effect). A hex already Rough or already holding wreckage
  does not change; in water it lies on the bed; in a standing building it
  costs nothing until the building collapses. Lighter 'Mechs leave nothing
  on the board. Before the wreckage is placed, a 'Mech destroyed while
  standing takes the TW p.128 salvage fall on its record, and a MechWarrior
  still alive inside takes the fall's pilot hit and, surviving it, the
  consciousness roll (TW p.41-42) that marks the pilot record for campaign
  bookkeeping. An ejected pilot (by
  auto-eject at that destruction, or from a hull left earlier) is outside the
  'Mech and takes no fall damage, as in any other fall.
  *Why:* destroyed medium and heavier 'Mechs should shape the ground.

### 2.2 Policies (choices TW leaves to a player)

*Why, for every policy:* it removes an in-game prompt for a situation TW
leaves to a player. Each is a per-unit standing order (`UnitPolicy`), set at
setup and changeable by the acting unit at its movement or attack
activation.

- **Ammo bin selection (TW pp.103–104).** TW lets the player draw from any
  matching bin. The engine depletes bins in the order of the unit's
  `ammoPolicy`.
- **Auto-eject (TO:AR p.165).** TO lets a player disable it before battle.
  The engine uses `autoEject` (default on), switchable mid-battle.
- **Flamer heat mode (TW p.303).** TW lets the attacker choose heat or damage
  per flamer attack. The engine uses `heatFlamer` (default on: heat only).
- **AMS engagement (TW p.129).** TW lets the defender choose which hitting
  missile attack an AMS engages. The engine uses `amsPolicy`: `expected`
  (default, the best expected damage saved), `firstHit`, `priority` (biggest
  volley) or `off`.

### 2.3 Simplifications

- **Weapons and physicals declared together (TW p.37).** TW declares physical
  attacks in their own phase; the engine takes weapons and physicals in one
  attack activation. Resolution keeps the TW order: weapons resolve, a PSR
  sweep lands, then physicals resolve against the post-weapon state.
  *Why:* one activation per unit is far more playable, and outcomes match TW
  except when a player would have changed their physical attack after seeing
  weapon results.
- **Charge / DFA against any enemy (TW pp.148–149).** TW allows only targets
  that finished moving; the engine lets you declare against an unmoved unit.
  *Why:* keeps `place`-on-enemy-hex intuitive, avoids holding chargers to the
  end of the activation order.
- **One movement declaration per unit (TW pp.39, 49–50, 160; TO:AR p.165).**
  Locomotion, posture change, shutdown, restart or ejection: one choice, one
  commit. *Why:* minimum interaction, closest TW play.
  - **Shut-down units move first.** *Why:* they can only restart, pass,
    abandon or eject; no empty turns.
  - **Shutdown and restart in the Movement Phase,** not the End Phase
    (TW p.160). A passed startup is the unit's movement and it still attacks
    that turn, so a restart costs one turn as in TW.
  - **Posture change plus movement.** A drop or stand-up and the movement
    after it share one declaration and one MP pool; movement follows only a
    successful posture change.
  - **No move-then-drop.** For a trailing drop, drop at the start of next
    turn's activation; the unit stays standing for the rest of this turn.
  - **One stand-up attempt per turn.** TW p.50 allows retries. *Why:* no
    second chance within an activation.
  - **Ejection** and **abandonment** replace the unit's movement, as in
    TO:AR p.165.
- **LOS along a hexside (TW pp.99–102, 119).** TW lets the target's player
  choose the hex chain. The engine always picks the chain worst for the
  attacker's to-hit, ties going to cover, then to the better attack
  direction. *Why:* no mid-resolution prompt to the defender.

### 2.4 House rulings where TW is silent

- **Voluntary abandonment (adapted from TO:AR p.165).** TO needs the 'Mech
  prone and shut down; here a 'Mech that is shut down at its movement
  activation (so shut down in an earlier turn) may declare `mode abandon`
  standing or prone: no roll, no pilot hits, and the unit is a hull at once
  in its posture. Until then normal rules apply (a PSR while shut down is an
  automatic fall). Ejection stays the emergency exit. *Why:* a planned
  abandonment that keeps the pilot unhurt and the hull standing is the most
  salvage-friendly outcome, paid for with a shut-down turn.
- A held club drops into the hex when its wielder falls, drops prone or leaves
  play.
- A dropped club of any kind stays intact in the hex, and a later pickup
  takes it back without a roll. A dropped tree is still unused and keeps
  its one successful club attack, even in a hex without woods; a dropped
  girder is not searched for again. *Why:* TW says girders are reusable
  indefinitely, a tree is spent only by a successful hit, and TW is silent
  on drops.
- A severed limb once used as a club is no longer salvageable.
- Picking up or carrying a club needs both hands working; losing either
  drops it. A destroyed shoulder only bars the swing.
- A 12 on the Determining roll blows off a limb or head even if the same hit
  destroyed it. *Why:* more excitement and a club for physical attacks; the
  location is lost either way.
- **Partial losses in the BV score (extends TW p.257).** `scoreReport` keeps
  TW's weights (+2 × enemy value, −1 × own value) but counts each unit's
  value times a lost share instead of only destroyed units: 1.0 out of play,
  0.5 crippled (TW p.258 conditions), else 0.5 × the damaged fraction.
  *Why:* a score read mid-battle or at a turn limit must reflect crippling
  and damage, or a turn-limit match with no kills always ties. Details:
  `docs/SCORING.md` §3.

### 2.5 Omissions (permanent)

- **Non-biped units and their rules:** quads, vehicles, infantry, battle
  armor, aerospace, ProtoMechs, support vehicles, and their PSR rows
  (skidding vehicles, sideslipping VTOLs).
- **Displacement rules (by design, for simpler play):** no rule moves a unit
  across hexes. The push attack, the domino effect, skidding / sliding
  (there is no pavement terrain, so no skid roll either) and displacement from charge / DFA are
  intentionally absent. Falls always happen in place (ground-movement falls
  across levels use the lower-hex rule); a faller landing on an occupied
  hex stays in the hex it came from, or, when another unit holds that hex
  too, in the nearest free hex it passed through. Charge / DFA resolve
  without moving either unit: the attacker stops in the hex before the
  target (the one exception to "nobody moves" is an attacker advancing into
  the hex its target vacated before the physical phase, after paying for
  the move).
- **Scenario and campaign rules (TW ch. 13):** victory conditions, forced
  withdrawal, crippling damage. The caller owns these (§1).

## 3. Engine conventions (and why they stay)

These are implementation choices, not rule changes.

- **Flat armor HP.** Each location holds an armor number, not dots; overflow
  moves inward only once a location's armor is gone.
- **Plain vs catastrophic destruction (by design).** Both wipe the location's
  remaining armor, front and rear (TW p.122 step 5); only catastrophic paths
  mark critical slots destroyed, so salvage must check both. The catastrophic
  mark sets every non-empty slot, soak slots (endo steel, ferro-fibrous, CASE,
  TSM, stealth systems) included, so the lost gear is on record for refit; empty
  slots hold nothing to destroy (TW p.124 rerolls them) and are never marked,
  so the mask round-trips as starting damage.
- **Unmodelled equipment takes criticals.** ECM, probes, C3, Artemis, MASC
  and other gear the engine does not simulate yet sit in `equipment`
  structure slots named after the item. A critical destroys the slot as
  TW p.124 requires, with no modelled effect until the item is simulated;
  only the slots TW pp.134–143 say cannot take a critical (CASE, endo steel,
  ferro-fibrous, stealth, TSM) re-roll.
- **Clan implicit CASE counts as standard CASE** until a Clan ammo outcome
  needs the difference.
- **Heat rolls use the same success convention** as every other avoid roll.
- **Platform constraints are permanent.** No Node APIs in the engine, zero
  runtime dependencies, strictest tsc, `en` i18n canonical, engine output in
  English, board styling as structured spans (no escape codes).

## 4. What I'll do

- **Physicals completion.** More physical weapons (spike, shield); the
  optional Punch/Kick-table election. (Charge / DFA, TW pp.148–150, are
  implemented without displacement, §2.5.)
- **Weapon to-hit audit P2 (TW pp.103–140).** One-Shot weapons; point-blank
  legality; Flak; Heavy Gauss move-and-fire PSR;
  MGA / A-Pod / B-Pod; missing catalog rows (Rocket Launchers, iNarc).
- **Thermal follow-ups.** Heat-causing weapons are in (TW pp.113, 139, 159,
  303; `heatFlamer` policy). Still to come: TO:AR fire and smoke (pp.41–46,
  needs hex targeting and wind), inferno SRMs and their ammo-explosion table
  (TW pp.141–142, needs special munitions), plasma double damage against
  woods/buildings, and a persona heuristic for heat weapons.
- **Water combat.** Hull breach, underwater weapons and LOS, physicals in
  water.
- **Buildings.** Basements, multi-floor interiors, structural transfer;
  hull-down; cover hits damaging buildings.
- **Equipment pipeline.** Artemis / Narc (AMS and Laser AMS are in, TW
  p.129, `amsPolicy`; still to come: the Narc single-missile AMS roll, TacOps
  Enhanced Missile Defense, AMS-vs-ECM questions); rotary
  jam-clear; Targeting Computer; TAG and guided ammo; LRM indirect fire;
  C3 / C3i; ECM bubble; Stealth Armor; switchable and special munitions.
- **Salvage valuation.** `salvageReport` lists what hulls and wreckage
  leave; pricing it and deciding who gets it (field control) belong to the
  campaign layer (§3).

## 5. What I won't

- Anything §2.5 omits: say so rather than report it as a gap.
- Anything that breaks a §3 platform constraint: MWO-scale numbers, Node APIs
  in the engine, runtime dependencies, per-dot armor, engine-owned victory or
  campaign state.
