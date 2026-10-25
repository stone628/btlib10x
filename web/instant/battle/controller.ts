/**
 * Battle controller: owns the BattleState, the dice, the persona context and
 * the acting unit's draft declaration. Every user interaction and every
 * persona decision arrives as a method call here; commits go to the engine and
 * then `drive()` runs the phase loop to the next prompt.
 *
 * The movement and attack rules mirror the terminal session layer
 * (`web/terminal/session.move.ts`, `session.attack.ts`): same logic, own copy.
 */
import {
  abandonPilot,
  attemptVoluntaryStartup,
  type BattleState,
  type ClubKind,
  cellAt,
  componentHitStatus,
  computePhysicalToHit,
  createBattle,
  DROP_MP_COST,
  declareAttacks,
  declarePickup,
  destroyedArms,
  destroyedLegs,
  effectiveMoveBudget,
  effectiveMovement,
  ejectPilot,
  executeMove,
  executePostureMove,
  type Facing,
  type FireSuggestion,
  type GameEvent,
  GYRO_DESTROYED_HITS,
  gameLoop,
  type HexCoord,
  hasWreckage,
  isPilotUnconscious,
  isShutdown,
  isTargetableBy,
  isTsmActive,
  isUnitAvailable,
  isUnitImmobile,
  isUnitOnBoard,
  isUnitRemoved,
  type MapDef,
  type MoveMode,
  type MoveStep,
  mechDefFor,
  meleeDeclarationProblem,
  neighbor,
  occupantAt,
  occupantTeamAt,
  oppositeFacing,
  type PhysicalAttackDecl,
  passAttack,
  passMovement,
  physicalDamage,
  physicalToHitTotal,
  postureMoveBudget,
  type RevealedLanding,
  reachableLandings,
  requireUnit,
  rotateFacing,
  setUnitPolicy,
  strikeMounts,
  suggestFireTargets,
  type Twist,
  type UnitInit,
  type UnitPolicy,
  type UnitState,
  validateAttacks,
  validatePhysicalAttack,
  validatePickup,
  voluntaryShutdown,
  waterDepth,
} from "btlib10x";
import { decide, newPersonaContext, type PersonaContext } from "../ai/persona";
import type { PersonaKey } from "../ai/persona.data";
import { t } from "../i18n";
import { createRng } from "../rng";
import { formatEvents, type LogEntry } from "./log";
import {
  type BattleResult,
  battleResult,
  makeStopper,
  startTotals,
  type VictoryMode,
} from "./victory";

/** A movement declaration the Orders panel offers. */
export type MoveChoice =
  | "standStill"
  | "walk"
  | "run"
  | "jump"
  | "standupStill"
  | "standupWalk"
  | "standupRun"
  | "proneTurn"
  | "proneStill"
  | "turn"
  | "pronestill"
  | "shutdown"
  | "startup"
  | "eject"
  | "abandon";

/** Draft of the acting unit's movement. */
export interface MoveDraft {
  choice: MoveChoice | null;
  landings: RevealedLanding[];
  landing: RevealedLanding | null;
}

/** Draft of the acting unit's attack declaration. */
export interface AttackDraft {
  twist: Twist;
  targetId: string | null;
  /** Weapon numbers (1-based keys of the resolved sheet's `weapons`). */
  weapons: number[];
  physical: PhysicalAttackDecl[];
  pickup: { source: ClubKind } | null;
  dropClub: boolean;
}

/** One physical attack the attack panel can offer. */
export interface PhysicalOption {
  readonly decl: PhysicalAttackDecl;
  readonly toHit: number;
  readonly damage: number;
}

interface Snapshot {
  battle: BattleState;
  rng: string;
  persona: PersonaContext;
  actorId: string | null;
  logLength: number;
}

const UNDO_DEPTH = 10;

type WeaponAttackDecl = Parameters<typeof validateAttacks>[2][number];

export class BattleController {
  state: BattleState;
  readonly rng = createRng(0);
  persona: PersonaContext;
  readonly control: Readonly<Record<string, PersonaKey | null>>;
  readonly mode: VictoryMode;
  readonly totals: Readonly<Record<string, number>>;
  actorId: string | null = null;
  move: MoveDraft | null = null;
  attack: AttackDraft | null = null;
  readonly log: LogEntry[] = [];
  result: BattleResult | null = null;
  /** Log a one-line summary of each persona decision. */
  reasoning = false;
  private undoStack: Snapshot[] = [];

  constructor(
    map: MapDef,
    units: readonly UnitInit[],
    control: Readonly<Record<string, PersonaKey | null>>,
    seed: number,
    mode: VictoryMode,
  ) {
    this.state = createBattle(map, units);
    this.rng.load(createRng(seed).snapshot());
    this.persona = newPersonaContext(seed);
    for (const [id, p] of Object.entries(control)) if (p) this.persona.assignments[id] = p;
    this.control = control;
    this.mode = mode;
    this.totals = startTotals(this.state);
    this.drive();
  }

  // ------------------------------------------------------------ prompt

  get actor(): UnitState | null {
    return this.actorId === null ? null : (this.state.units[this.actorId] ?? null);
  }

  /** Persona of the acting unit, or null when a player acts (or nobody). */
  get actorPersona(): PersonaKey | null {
    return this.actorId === null ? null : (this.control[this.actorId] ?? null);
  }

  get phase(): "movement" | "attack" | "over" {
    if (this.result !== null) return "over";
    return this.state.phase === "attack" ? "attack" : "movement";
  }

  private drive(): void {
    const events: GameEvent[] = [];
    let stopped = false;
    const r = gameLoop(this.state, this.rng, makeStopper(this.mode), events);
    stopped = r.stopped;
    this.log.push(...formatEvents(events, this.state));
    this.move = null;
    this.attack = null;
    if (stopped) {
      // The stopper fires on the next turn's initiative: drop that turn's banner.
      if (this.log[this.log.length - 1]?.text === t("log.turn", { turn: this.state.turn }))
        this.log.pop();
      this.actorId = null;
      this.result = battleResult(this.state, this.mode, this.totals);
      this.log.push({ text: t("log.over"), cls: "banner" });
      return;
    }
    this.actorId = r.actorId;
    const actor = this.actor;
    if (actor === null) return;
    if (this.state.phase === "movement") {
      this.move = { choice: null, landings: [], landing: null };
    } else {
      this.attack = {
        twist: "front",
        targetId: null,
        weapons: [],
        physical: [],
        pickup: null,
        dropClub: false,
      };
      const best = this.fireSuggestion()?.targets[0];
      if (best) this.attack.targetId = best.targetId;
    }
    this.log.push({
      text: t(this.state.phase === "movement" ? "log.toMove" : "log.toAttack", {
        id: actor.id,
        model: actor.model,
      }),
      cls: "prompt",
    });
  }

  /** Run an engine commit atomically: on a throw, state, dice and log roll back. */
  private commit(fn: (sink: GameEvent[]) => void): void {
    const battle = structuredClone(this.state);
    const rng = this.rng.snapshot();
    const logLength = this.log.length;
    const move = structuredClone(this.move);
    const attack = structuredClone(this.attack);
    if (this.actorPersona === null) this.pushUndo();
    try {
      const sink: GameEvent[] = [];
      fn(sink);
      this.log.push(...formatEvents(sink, this.state));
      this.drive();
    } catch (e) {
      this.state = battle;
      this.rng.load(rng);
      this.log.length = logLength;
      this.move = move;
      this.attack = attack;
      if (this.actorPersona === null) this.undoStack.pop();
      throw e;
    }
  }

  // ------------------------------------------------------------ undo

  private pushUndo(): void {
    this.undoStack.push({
      battle: structuredClone(this.state),
      rng: this.rng.snapshot(),
      persona: structuredClone(this.persona),
      actorId: this.actorId,
      logLength: this.log.length,
    });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Back to the last player prompt before its commit (state, dice, AI memory and log). */
  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) throw new Error(t("err.nothingToUndo"));
    this.state = snap.battle;
    this.rng.load(snap.rng);
    this.persona = snap.persona;
    this.log.length = snap.logLength;
    this.result = null;
    this.log.push({ text: t("log.undone"), cls: "dim" });
    // Re-enter the prompt with a fresh draft.
    this.actorId = snap.actorId;
    this.move = null;
    this.attack = null;
    if (this.state.phase === "movement") this.move = { choice: null, landings: [], landing: null };
    else
      this.attack = {
        twist: "front",
        targetId: this.fireSuggestion()?.targets[0]?.targetId ?? null,
        weapons: [],
        physical: [],
        pickup: null,
        dropClub: false,
      };
  }

  // ------------------------------------------------------------ movement

  private requireMove(): { unit: UnitState; draft: MoveDraft } {
    const unit = this.actor;
    if (unit === null || this.move === null) throw new Error(t("err.notMovement"));
    return { unit, draft: this.move };
  }

  /** Movement choices legal for the acting unit right now (TW pp. 49–50, 122). */
  moveChoices(): MoveChoice[] {
    const unit = this.actor;
    if (unit === null || this.move === null) return [];
    if (unit.shutdown === "heat") return ["abandon", "eject"];
    if (isShutdown(unit)) return ["startup", "abandon", "eject"];
    const legs = destroyedLegs(unit.damage);
    const arms = destroyedArms(unit.damage);
    if (isUnitImmobile(unit.damage)) {
      return unit.prone ? ["pronestill", "shutdown", "eject"] : ["standStill", "shutdown", "eject"];
    }
    if (legs >= 2 || (legs === 1 && arms >= 2)) return ["pronestill", "shutdown", "eject"];
    if (unit.prone) {
      const out: MoveChoice[] = ["turn", "pronestill"];
      if (!isGyroDestroyed(unit) && walkBudget(unit) >= 1) {
        out.push("standupStill", "standupWalk");
        if (legs === 0) out.push("standupRun");
      }
      return [...out, "shutdown", "eject"];
    }
    const out: MoveChoice[] = ["standStill", "walk", "run"];
    if (jumpBudget(unit) >= 1) out.push("jump");
    if (walkBudget(unit) >= DROP_MP_COST) out.push("proneTurn", "proneStill");
    return [...out, "shutdown", "eject"];
  }

  /** Movement points for a choice (after the posture cost), for the Orders panel. */
  budgetFor(choice: MoveChoice): number {
    const unit = this.actor;
    if (unit === null) return 0;
    const m = movementOf(unit);
    const walk = effectiveMoveBudget("walk", m, unit.heat);
    switch (choice) {
      case "walk":
      case "run":
      case "jump":
        return effectiveMoveBudget(choice, m, unit.heat);
      case "proneTurn":
        return postureMoveBudget(unit, "drop", walk);
      case "turn":
        return walk;
      case "standupWalk":
        return postureMoveBudget(unit, "standUp", walk);
      case "standupRun":
        return postureMoveBudget(unit, "standUp", effectiveMoveBudget("run", m, unit.heat));
      default:
        return 0;
    }
  }

  chooseMove(choice: MoveChoice): void {
    const { unit, draft } = this.requireMove();
    if (!this.moveChoices().includes(choice)) {
      throw new Error(t("err.moveNotLegal", { id: unit.id }));
    }
    draft.choice = choice;
    draft.landing = null;
    draft.landings = this.reachable(unit, choice);
  }

  /** Landings at one hex for the chosen mode, cheapest path per facing. */
  landingsAt(hex: HexCoord): RevealedLanding[] {
    const draft = this.move;
    if (draft === null) return [];
    return draft.landings.filter((l) => l.hex.col === hex.col && l.hex.row === hex.row);
  }

  chooseLanding(landing: RevealedLanding): void {
    const { draft } = this.requireMove();
    draft.landing = landing;
  }

  clearMove(): void {
    const { draft } = this.requireMove();
    draft.choice = null;
    draft.landing = null;
    draft.landings = [];
  }

  /** Locomotion that the queued steps run under, for path replay and commit. */
  private locomotion(choice: MoveChoice): MoveMode {
    switch (choice) {
      case "walk":
      case "run":
      case "jump":
      case "standStill":
        return choice;
      case "standupWalk":
      case "proneTurn":
      case "turn":
        return "walk";
      case "standupRun":
        return "run";
      default:
        return "standStill";
    }
  }

  private reachable(unit: UnitState, choice: MoveChoice): RevealedLanding[] {
    if (
      choice === "standStill" ||
      choice === "standupStill" ||
      choice === "proneStill" ||
      choice === "pronestill" ||
      choice === "shutdown" ||
      choice === "startup" ||
      choice === "eject" ||
      choice === "abandon"
    ) {
      return [];
    }
    const battle = this.state;
    const def = mechDefFor(unit);
    const m = effectiveMovement(
      def,
      unit.damage,
      unit.critSlotsDestroyed,
      isTsmActive(def, unit.heat),
      waterDepth(cellAt(battle, unit.position).terrain),
    );
    let walking = effectiveMoveBudget("walk", m, unit.heat);
    let running = effectiveMoveBudget("run", m, unit.heat);
    const jumping = effectiveMoveBudget("jump", m, unit.heat);
    let locomotion = this.locomotion(choice);
    let prone = unit.prone;
    const standup = choice === "standupWalk" || choice === "standupRun";
    if (choice === "proneTurn") {
      prone = true;
      walking = postureMoveBudget(unit, "drop", walking);
    } else if (choice === "turn") {
      prone = true;
    } else if (standup) {
      prone = false;
      if (choice === "standupRun") running = postureMoveBudget(unit, "standUp", running);
      else walking = postureMoveBudget(unit, "standUp", walking);
    }
    if (locomotion === "standStill") locomotion = "walk";
    const plain = choice === "walk" || choice === "run" || choice === "jump";
    return reachableLandings(unit.position, unit.facing, {
      mode: locomotion,
      walking,
      running,
      jumping,
      prone,
      ...(prone && isGyroDestroyed(unit) ? { proneTurnMax: 1 } : {}),
      grid: battle,
      team: unit.team,
      ...(standup ? { standup: true } : {}),
      wreckageAt: (hex: HexCoord): boolean => hasWreckage(battle, hex),
      occupantTeam: (hex: HexCoord): number | undefined => {
        const team = occupantTeamAt(battle, hex);
        if (team !== undefined) return team;
        for (const u of Object.values(battle.units)) {
          if (isUnitRemoved(u) || u.id === unit.id) continue;
          if (u.meleeCharge?.hex.col === hex.col && u.meleeCharge.hex.row === hex.row)
            return u.team;
        }
        return undefined;
      },
      ...(plain
        ? {
            meleeOk: (stop: HexCoord, targetHex: HexCoord, kind: "charge" | "dfa"): boolean => {
              const target = occupantAt(battle, targetHex);
              return (
                target !== undefined &&
                isTargetableBy(unit, target) &&
                meleeDeclarationProblem(battle, unit.id, stop, target.id, kind, jumping) === null
              );
            },
          }
        : {}),
    });
  }

  /** Commit the movement draft (the terminal's `done`). */
  commitMove(): void {
    const { unit, draft } = this.requireMove();
    // A bare `done` passes for a shut-down or unconscious unit, and stands still otherwise.
    const down = isShutdown(unit) || isPilotUnconscious(unit);
    const choice = draft.choice ?? (unit.prone && !down ? null : "standStill");
    if (choice === null) throw new Error(t("err.chooseMode"));
    // As the terminal's `done`: no landing moves no hex (a posture change in place,
    // or a walk / run / jump of zero hexes).
    const id = unit.id;
    const rng = this.rng;
    const locomotion = this.locomotion(choice);
    const { steps, finalFacing } =
      draft.landing === null
        ? { steps: [] as MoveStep[], finalFacing: null }
        : pathSteps(
            unit,
            draft.landing,
            locomotion,
            choice === "standupWalk" || choice === "standupRun",
          );
    const opts = finalFacing === null ? { rng } : { finalFacing, rng };
    this.commit((sink) => {
      switch (choice) {
        case "shutdown":
          voluntaryShutdown(this.state, id, sink);
          return;
        case "startup":
          attemptVoluntaryStartup(this.state, id, sink, rng);
          return;
        case "eject":
          ejectPilot(this.state, id, rng, sink);
          return;
        case "abandon":
          abandonPilot(this.state, id, sink);
          return;
      }
      const u = requireUnit(this.state, id);
      if (isShutdown(u) || isPilotUnconscious(u)) {
        passMovement(this.state, id);
        return;
      }
      if (choice === "standupStill" || choice === "standupWalk" || choice === "standupRun") {
        executePostureMove(this.state, id, "standUp", locomotion, steps, sink, opts);
      } else if (choice === "proneTurn" || choice === "proneStill") {
        executePostureMove(
          this.state,
          id,
          "drop",
          choice === "proneTurn" ? "walk" : "standStill",
          steps,
          sink,
          opts,
        );
      } else if (choice === "turn") {
        executeMove(this.state, id, "walk", steps, sink, { rng });
      } else if (choice === "pronestill") {
        executeMove(this.state, id, "standStill", [], sink, { rng });
      } else {
        executeMove(this.state, id, choice, steps, sink, opts);
      }
    });
  }

  // ------------------------------------------------------------ attack

  private requireAttack(): { unit: UnitState; draft: AttackDraft } {
    const unit = this.actor;
    if (unit === null || this.attack === null) throw new Error(t("err.notAttack"));
    return { unit, draft: this.attack };
  }

  fireSuggestion(): FireSuggestion | null {
    const unit = this.actor;
    if (unit === null || this.attack === null) return null;
    return suggestFireTargets(this.state, unit.id, this.attack.twist, this.attack.dropClub);
  }

  /** Change the torso twist; drops weapon checks the new twist cannot fire. */
  setTwist(twist: Twist): void {
    const { draft } = this.requireAttack();
    if (draft.twist === twist) return;
    draft.twist = twist;
    const targets = this.fireSuggestion()?.targets ?? [];
    const target = targets.find((x) => x.targetId === draft.targetId);
    const ok = new Set((target?.weapons ?? []).map((w) => w.weaponIndex));
    draft.weapons = draft.weapons.filter((w) => ok.has(w));
    draft.physical = draft.physical.filter((d) => this.physicalValid(d));
  }

  setTarget(targetId: string): void {
    const { draft } = this.requireAttack();
    if (draft.targetId === targetId) return;
    draft.targetId = targetId;
    draft.weapons = [];
  }

  /** Check or uncheck a weapon; the engine validates the whole declaration. */
  toggleWeapon(weaponIndex: number): void {
    const { unit, draft } = this.requireAttack();
    if (draft.targetId === null) throw new Error(t("err.noTarget"));
    if (draft.weapons.includes(weaponIndex)) {
      draft.weapons = draft.weapons.filter((w) => w !== weaponIndex);
      return;
    }
    if (draft.pickup !== null) throw new Error(t("err.pickupExclusive"));
    const next = [...draft.weapons, weaponIndex];
    validateAttacks(this.state, unit.id, this.weaponDecls(next), draft.physical, {
      twist: draft.twist,
      dropClub: draft.dropClub,
    });
    draft.weapons = next;
  }

  /** Check every fireable weapon on the target that the declaration allows. */
  checkAll(on: boolean): void {
    const { draft } = this.requireAttack();
    if (!on) {
      draft.weapons = [];
      return;
    }
    const target = this.fireSuggestion()?.targets.find((x) => x.targetId === draft.targetId);
    for (const w of this.fireableWeapons(target?.weapons ?? [], target)) {
      if (draft.weapons.includes(w)) continue;
      try {
        this.toggleWeapon(w);
      } catch {
        // skip weapons the declaration cannot take (physical conflicts)
      }
    }
  }

  private fireableWeapons(list: readonly { weaponIndex: number }[], _t: unknown): number[] {
    return list.map((w) => w.weaponIndex);
  }

  private weaponDecls(weapons: readonly number[]): WeaponAttackDecl[] {
    const targetId = this.attack?.targetId;
    if (!targetId) return [];
    return weapons.map((weaponIndex) => ({ targetId, weaponIndex }));
  }

  private physicalValid(d: PhysicalAttackDecl): boolean {
    const unit = this.actor;
    const draft = this.attack;
    if (unit === null || draft === null) return false;
    return validatePhysicalAttack(this.state, unit.id, d, draft.twist, draft.dropClub).ok;
  }

  /** Physical attacks legal against adjacent enemies with the current twist. */
  physicalOptions(): PhysicalOption[] {
    const unit = this.actor;
    const draft = this.attack;
    if (unit === null || draft === null) return [];
    const out: PhysicalOption[] = [];
    const def = mechDefFor(unit);
    for (const target of Object.values(this.state.units)) {
      if (target.id === unit.id || !isUnitOnBoard(target) || !isTargetableBy(unit, target))
        continue;
      const decls: PhysicalAttackDecl[] = [
        { type: "punch", targetId: target.id, limb: "leftArm" },
        { type: "punch", targetId: target.id, limb: "rightArm" },
        { type: "kick", targetId: target.id, limb: "leftLeg" },
        { type: "kick", targetId: target.id, limb: "rightLeg" },
        { type: "club", targetId: target.id },
        ...strikeMounts(def).map(
          ({ arm, weapon }): PhysicalAttackDecl => ({
            type: "strike",
            targetId: target.id,
            limb: arm,
            weapon,
          }),
        ),
      ];
      for (const decl of decls) {
        if (!validatePhysicalAttack(this.state, unit.id, decl, draft.twist, draft.dropClub).ok)
          continue;
        const mods = computePhysicalToHit(
          this.state,
          unit,
          target,
          decl.type,
          decl.limb,
          decl.weapon,
        );
        out.push({
          decl,
          toHit: physicalToHitTotal(mods),
          damage: physicalDamage(decl.type, unit, decl.limb, decl.weapon),
        });
      }
    }
    return out;
  }

  togglePhysical(decl: PhysicalAttackDecl): void {
    const { unit, draft } = this.requireAttack();
    const same = (d: PhysicalAttackDecl) =>
      d.type === decl.type && d.targetId === decl.targetId && d.limb === decl.limb;
    if (draft.physical.some(same)) {
      draft.physical = draft.physical.filter((d) => !same(d));
      return;
    }
    if (draft.pickup !== null) throw new Error(t("err.pickupExclusive"));
    // One type per turn; two punches (one per arm) are the exception (TW p.144).
    const types = new Set(draft.physical.map((d) => d.type));
    if (types.size > 0 && !(types.size === 1 && types.has("punch") && decl.type === "punch")) {
      throw new Error(t("err.oneType"));
    }
    const next = [...draft.physical, decl];
    validateAttacks(this.state, unit.id, this.weaponDecls(draft.weapons), next, {
      twist: draft.twist,
      dropClub: draft.dropClub,
    });
    draft.physical = next;
  }

  /** Club sources the unit could pick up now (TW p.146). */
  pickupOptions(): ClubKind[] {
    const unit = this.actor;
    if (unit === null || this.attack === null || unit.club !== null) return [];
    const out: ClubKind[] = [];
    for (const source of ["limb", "tree", "girder"] as const) {
      const r = validatePickup(this.state, unit.id, { source });
      if (r.ok) out.push(source);
    }
    return out;
  }

  togglePickup(source: ClubKind): void {
    const { draft } = this.requireAttack();
    if (draft.pickup?.source === source) {
      draft.pickup = null;
      return;
    }
    if (draft.weapons.length > 0 || draft.physical.length > 0 || draft.dropClub) {
      throw new Error(t("err.pickupExclusive"));
    }
    draft.pickup = { source };
  }

  toggleDrop(): void {
    const { unit, draft } = this.requireAttack();
    if (unit.club === null) throw new Error(t("err.noClub"));
    if (draft.pickup !== null) throw new Error(t("err.pickupExclusive"));
    draft.dropClub = !draft.dropClub;
    draft.weapons = [];
    draft.physical = [];
  }

  clearAttack(): void {
    const { draft } = this.requireAttack();
    draft.weapons = [];
    draft.physical = [];
    draft.pickup = null;
    draft.dropClub = false;
  }

  /** Commit the attack draft (the terminal's `done`); an empty draft passes. */
  commitAttack(): void {
    const { unit, draft } = this.requireAttack();
    const id = unit.id;
    const weapons = this.weaponDecls(draft.weapons);
    const physical = draft.physical;
    const empty =
      weapons.length === 0 && physical.length === 0 && draft.pickup === null && !draft.dropClub;
    const opts = { twist: draft.twist, dropClub: draft.dropClub };
    const pickup = draft.pickup;
    this.commit((sink) => {
      if (empty) {
        passAttack(this.state, id);
        return;
      }
      if (pickup !== null) {
        declarePickup(this.state, id, { source: pickup.source }, sink);
        return;
      }
      declareAttacks(this.state, id, weapons, physical, sink, this.rng, opts);
    });
  }

  // ------------------------------------------------------------ policy

  setPolicy(patch: Partial<UnitPolicy>): void {
    const unit = this.actor;
    if (unit === null) throw new Error(t("err.noActor"));
    setUnitPolicy(this.state, unit.id, patch);
  }

  // ------------------------------------------------------------ persona player

  /** Let the persona play the current prompt. Returns false when a player acts. */
  stepAi(): boolean {
    const key = this.actorPersona;
    const actor = this.actor;
    if (key === null || actor === null || this.result !== null) return false;
    if (!isUnitAvailable(actor)) return false;
    const decision = decide(
      { battle: this.state, actorId: actor.id, pending: false },
      key,
      this.persona,
    );
    if (decision === null) return false;
    this.persona = decision.next;
    if (this.reasoning) {
      const best = decision.trace.candidates[0];
      this.log.push({
        text: t("log.reasoning", {
          id: actor.id,
          persona: key,
          posture: decision.trace.posture,
          choice: best
            ? `${best.label} (${best.score.toFixed(1)})`
            : decision.trace.commands.join("; "),
          n: decision.trace.candidates.length,
        }),
        cls: "dim",
      });
    }
    const before = this.actorId;
    const phase = this.state.phase;
    try {
      for (const cmd of decision.commands) this.runAiCommand(cmd);
    } catch (e) {
      this.log.push({ text: t("log.aiFailed", { id: actor.id, msg: String(e) }), cls: "err" });
    }
    // A failed persona command never stalls the battle: pass the prompt.
    if (this.actorId === before && this.state.phase === phase && this.result === null) {
      if (phase === "movement") {
        if (this.move) {
          this.move.choice = actor.prone && !isShutdown(actor) ? "pronestill" : "standStill";
          this.move.landing = null;
        }
        this.commitMove();
      } else {
        this.clearAttack();
        this.commitAttack();
      }
    }
    return true;
  }

  /** The persona player speaks the terminal's command words; map them to calls. */
  private runAiCommand(cmd: string): void {
    const [verb, ...args] = cmd.split(/\s+/);
    switch (verb) {
      case "cancel":
        if (this.move) this.clearMove();
        if (this.attack) this.clearAttack();
        return;
      case "mode":
        this.chooseMove(aiMoveChoice(args[0] ?? "", args[1]));
        return;
      case "place": {
        const hex = { col: Number(args[0]), row: Number(args[1]) };
        const landing = this.landingsAt(hex).find((l) => l.facing === args[2]);
        if (!landing) throw new Error(`no landing ${cmd}`);
        this.chooseLanding(landing);
        return;
      }
      case "done":
        if (this.phase === "movement") this.commitMove();
        else this.commitAttack();
        return;
      case "torso":
        this.setTwist(
          args[0] === "left" ? "leftSide" : args[0] === "right" ? "rightSide" : "front",
        );
        return;
      case "drop":
        this.toggleDrop();
        return;
      case "pickup":
        this.togglePickup(args[0] as ClubKind);
        return;
      case "fire": {
        this.setTarget(args[0] ?? "");
        for (const n of args.slice(1)) this.toggleWeapon(Number(n));
        return;
      }
      case "punch":
      case "kick":
      case "club":
      case "strike": {
        const target = args[0] ?? "";
        const side = args[1];
        const limb =
          verb === "kick"
            ? side === "left"
              ? "leftLeg"
              : "rightLeg"
            : side === "left"
              ? "leftArm"
              : side === "right"
                ? "rightArm"
                : undefined;
        if (verb === "club") {
          this.togglePhysical({ type: "club", targetId: target });
          return;
        }
        if (verb === "strike") {
          const opt = this.physicalOptions().find(
            (o) =>
              o.decl.type === "strike" &&
              o.decl.targetId === target &&
              (limb === undefined || o.decl.limb === limb),
          );
          if (!opt) throw new Error(`no strike ${cmd}`);
          this.togglePhysical(opt.decl);
          return;
        }
        this.togglePhysical({ type: verb, targetId: target, ...(limb ? { limb } : {}) });
        return;
      }
      default:
        throw new Error(`unknown persona command ${cmd}`);
    }
  }
}

function aiMoveChoice(word: string, loco: string | undefined): MoveChoice {
  switch (word) {
    case "standstill":
      return "standStill";
    case "walk":
    case "run":
    case "jump":
    case "shutdown":
    case "startup":
    case "eject":
    case "abandon":
    case "turn":
    case "pronestill":
      return word;
    case "standup":
      return loco === "walk" ? "standupWalk" : loco === "run" ? "standupRun" : "standupStill";
    case "prone":
      return loco === "pronestill" ? "proneStill" : "proneTurn";
    default:
      throw new Error(`unknown mode ${word}`);
  }
}

function movementOf(unit: UnitState) {
  const def = mechDefFor(unit);
  return effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, isTsmActive(def, unit.heat));
}

function walkBudget(unit: UnitState): number {
  return effectiveMoveBudget("walk", movementOf(unit), unit.heat);
}

function jumpBudget(unit: UnitState): number {
  return effectiveMoveBudget("jump", movementOf(unit), unit.heat);
}

/** TW p.125: a destroyed gyro means the 'Mech can never stand again. */
export function isGyroDestroyed(unit: UnitState): boolean {
  return (
    componentHitStatus(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed).gyro >=
    GYRO_DESTROYED_HITS
  );
}

/**
 * Replay a landing's path into engine steps. Jump turns are free (the engine
 * rejects turn steps while jumping), so the landing facing travels as
 * `finalFacing`. A stand-up that stays on its hex with a new facing is the
 * TW p.50 free pick: no steps, facing only.
 */
function pathSteps(
  unit: UnitState,
  landing: RevealedLanding,
  locomotion: MoveMode,
  standup: boolean,
): { steps: MoveStep[]; finalFacing: Facing | null } {
  if (
    standup &&
    landing.path.length === 0 &&
    landing.hex.col === unit.position.col &&
    landing.hex.row === unit.position.row &&
    landing.facing !== unit.facing
  ) {
    return { steps: [], finalFacing: landing.facing };
  }
  const jumping = locomotion === "jump";
  const steps: MoveStep[] = [];
  let hex: HexCoord = unit.position;
  let facing: Facing = unit.facing;
  for (const step of landing.path) {
    const frag = step.fragment;
    if (frag === "R" || frag === "L") {
      const delta = frag === "R" ? 1 : -1;
      facing = rotateFacing(facing, delta);
      if (!jumping) steps.push({ kind: "turn", facings: delta });
      continue;
    }
    const to = neighbor(hex, frag === "B" ? oppositeFacing(facing) : facing);
    steps.push({ kind: "enter", to });
    hex = to;
  }
  return { steps, finalFacing: jumping ? landing.facing : null };
}
