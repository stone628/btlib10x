# btlib10x Vision

This document states direction only. Rule-by-rule implementation status,
the public API, reference tables, usage and record-sheet authoring are
documented separately.

## 1. Goal: a simulator, not a game

- **Engine.** `btlib10x` is a zero-dependency TypeScript library that simulates
  BattleTech for **bipedal 'Mechs only**. It is deterministic given an injected
  `Rng`, mutates one serializable `BattleState` in place on a single thread,
  and snapshots to plain JSON. The engine never decides a winner: the caller
  owns the stop condition. Atomicity holds at the caller's commit boundary
  (e.g. snapshot and roll back), not per rule call.
- **Rules principle.** The engine implements *Total Warfare* (TW) as written
  wherever it can. It adopts a *Tactical Operations* (TO) rule only where TW
  leaves a gap the simulation needs filled. Where a rule is too deep or fiddly
  to pay for itself in play, or asks a player for a choice the simulator must
  make on its own, the engine follows an explicit **policy** instead (the
  per-unit ammo policy is the model). Every such departure is listed in §2;
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
  (on by default, per-unit opt-out) when the cockpit or center torso is lost.
  *Why:* TW gives a doomed pilot no way out, and ejection is what turns a
  fight into salvage. *Not adopted:* planetary-condition modifiers and the
  submerged-cockpit ban.
- **Wrecks (house rule built on TO:AR p.155).** A unit whose pilot ejects or
  is killed leaves a permanent, impassable wreck; its height, set by size and
  posture, blocks LOS and gives partial cover. *Why:* an abandoned hulk
  should shape the board. TO's own rough-hex rule waits on open entry (§4).

### 2.2 Policies (choices TW leaves to a player)

- **Ammo bin selection (TW pp.103–104).** TW lets the player draw from any
  matching bin and switch freely. The engine depletes bins by a per-unit
  standing order. *Why:* bin choice only matters for crit exposure, so one
  standing order replaces a decision on every shot.
- **LOS along a hexside (TW pp.99–102, 119).** TW lets the target's player
  choose which hex the line passes through. The engine breaks the tie
  deterministically, and a boundary attack direction resolves in the
  defender's favour. *Why:* no mid-resolution prompt to the defender. Still to
  be verified against the TW diagrams.

### 2.3 Simplifications

- **Weapons and physicals declared together (TW p.37).** TW declares physical
  attacks in their own phase; the engine takes weapons and physicals in one
  attack activation. Resolution keeps the TW order: weapons resolve, a PSR
  sweep lands, then physicals resolve against the post-weapon state.
  *Why:* one activation per unit is far more playable, and outcomes match TW
  except when a player would have changed their physical attack after seeing
  weapon results.
- **One movement declaration per unit (TW pp.39, 49–50, 160; TO:AR p.165).**
  Locomotion, posture change, shutdown, restart or ejection: one choice, one
  commit. *Why:* minimum interaction, closest TW play.
  - **Shut-down units move first.** *Why:* they can only restart, pass or
    eject; no empty turns.
  - **Shutdown and restart in the Movement Phase,** not the End Phase
    (TW p.160).
  - **Posture change plus movement.** A drop or stand-up and the movement
    after it share one declaration and one MP pool; movement follows only a
    successful posture change.
  - **No move-then-drop.** For a trailing drop, drop at the start of next
    turn's activation; the unit stays standing for the rest of this turn.
  - **One stand-up attempt per turn.** TW p.50 allows retries. *Why:* no
    second chance within an activation.
  - **Ejection** replaces the unit's movement, as in TO:AR p.165.

### 2.4 House rulings where TW is silent

- A held club drops into the hex when its wielder falls, drops prone or leaves
  play.
- A severed limb once used as a club is no longer salvageable.

### 2.5 Omissions (permanent)

- **Non-biped units and their rules:** quads, vehicles, infantry, battle
  armor, aerospace, ProtoMechs, support vehicles, and their PSR rows
  (skidding vehicles, sideslipping VTOLs).
- **Scenario and campaign rules (TW ch. 13):** victory conditions, forced
  withdrawal, crippling damage. The caller owns these (§1).

## 3. Engine conventions (and why they stay)

These are implementation choices, not rule changes.

- **Flat armor HP.** Each location holds an armor number, not dots; overflow
  moves inward only once a location's armor is gone.
- **Plain vs catastrophic destruction (by design).** Only catastrophic paths
  mark critical slots destroyed, so salvage must check both.
- **Clan implicit CASE counts as standard CASE** until a Clan ammo outcome
  needs the difference.
- **Heat rolls use the same success convention** as every other avoid roll.
- **Platform constraints are permanent.** No Node APIs in the engine, zero
  runtime dependencies, strictest tsc, `en` i18n canonical, engine output in
  English, board styling as structured spans (no escape codes).

## 4. What I'll do

- **Physicals completion.** Charge / DFA (TW pp.151–152); more physical
  weapons (spike, shield); the optional Punch/Kick-table election; domino
  effect from a push; push and charge / DFA PSRs.
- **Weapon to-hit audit P2 (TW pp.103–140).** One-Shot weapons; point-blank
  legality; Flak; plasma heat damage; Heavy Gauss move-and-fire PSR;
  MGA / A-Pod / B-Pod; missing catalog rows (Rocket Launchers, Plasma Cannon,
  iNarc).
- **Water combat.** Hull breach, underwater weapons and LOS, physicals in
  water.
- **Buildings & wrecks.** Basements, multi-floor interiors, structural
  transfer; hull-down; wreck destruction and open entry; cover hits damaging
  buildings.
- **Equipment pipeline.** Artemis / Narc / AMS (and ECM interaction); rotary
  jam-clear; Targeting Computer; TAG and guided ammo; LRM indirect fire;
  C3 / C3i; ECM bubble; Stealth Armor; switchable and special munitions.
- **Salvage module.** A pure function over the end state (§3).

## 5. What I won't

- Anything §2.5 omits: say so rather than report it as a gap.
- Anything that breaks a §3 platform constraint: MWO-scale numbers, Node APIs
  in the engine, runtime dependencies, per-dot armor, engine-owned victory or
  campaign state.
