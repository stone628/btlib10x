/**
 * Instant Action (docs/INSTANT.md): the DOM-free parts — deployment
 * (TW p. 256), victory modes, the battle controller and persona battles.
 * Imports `web/instant/*`, which resolves `btlib10x` to `dist/`.
 */
/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildUnitInit,
  DEFAULT_UNIT_POLICY,
  ensureMapRegistered,
  type Facing,
  type HexCoord,
  type MapDef,
  mechDefFor,
  setSlotDestroyed,
  type UnitState,
} from "btlib10x";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSONA_KEYS, PERSONAS, type PersonaKey } from "../web/instant/ai/persona.data";
import AVATARS from "../web/instant/avatars/mech-avatars.json";
import { type Beat, beatTime, buildBeats, isReel, legTimes } from "../web/instant/battle/beats";
import { clipNeeds, emptyRects } from "../web/instant/battle/camera";
import { BattleController, type StepRecord } from "../web/instant/battle/controller";
import {
  autoPlace,
  edgeHexes,
  inwardFacing,
  oppositeEdge,
  rollOff,
  setupRng,
} from "../web/instant/battle/deploy";
import { unitLoss, type VictoryMode } from "../web/instant/battle/victory";
import { bannerSub } from "../web/instant/flow";
import { en } from "../web/instant/i18n/en";
import { ko } from "../web/instant/i18n/ko";
import { commitAlias } from "../web/instant/input";
import { clipStatus, JUMP_LIFT, MapAnimator } from "../web/instant/map/anim";
import { avatarOf, DEFAULT_GLYPH, glyphOf } from "../web/instant/map/avatars";
import type { MapView } from "../web/instant/map/view";
import { resolveFacing } from "../web/instant/map/view";
import { createRng } from "../web/instant/rng";
import { battleKey } from "../web/instant/screens/battle";
import { frameTarget } from "../web/instant/screens/battle.attack";
import {
  engineTip,
  gyroTip,
  heatSinkTip,
  heatTip,
  lifeSupportTip,
  pilotTip,
  sensorTip,
} from "../web/instant/screens/battle.hints";
import { sheetPolicy } from "../web/instant/screens/battle.hud";
import { critTip } from "../web/instant/screens/battle.sheet";
import { debriefKey } from "../web/instant/screens/debrief";
import { closesMessage, menuKey, openMenu, prefItems } from "../web/instant/screens/menu";
import { openOptions, optionsKey } from "../web/instant/screens/options";
import { pileTip } from "../web/instant/screens/piles";
import { POLICY_ROWS, policyCodeOf } from "../web/instant/screens/policy";
import {
  CONTROLS,
  personaFacts,
  personaKey,
  personaModal,
  weightMax,
} from "../web/instant/screens/setup.persona";
import { titleItems, titleKey } from "../web/instant/screens/title";
import {
  addedSlot,
  bvOf,
  defaultFilter,
  emptyLoadout,
  filterMechs,
  generateSide,
  loadoutProblem,
  randomLoadout,
} from "../web/instant/setup/loadout";
import {
  app,
  leaveWarns,
  newBattleUi,
  setAiPace,
  setAiReasoning,
  setAnimSpeed,
  setGlyphs,
} from "../web/instant/state";
import { runChunks } from "../web/terminal/cli";
import { newSession } from "../web/terminal/session";

function quickstart(): MapDef {
  const map = ensureMapRegistered("quickstart");
  if (!map) throw new Error("quickstart map missing");
  return map;
}

function battle(
  mode: VictoryMode,
  control: Record<string, PersonaKey | null>,
  seed = 42,
  units: [string, string, 1 | 2, HexCoord, Facing][] = [
    ["A1", "HBK-4G", 1, { col: 4, row: 16 }, "n"],
    ["A2", "CN9-YLW2", 1, { col: 12, row: 16 }, "n"],
    ["B1", "GRF-1N", 2, { col: 4, row: 1 }, "s"],
    ["B2", "ENF-4R", 2, { col: 12, row: 1 }, "s"],
  ],
): BattleController {
  const inits = units.map(([id, model, team, hex, facing]) =>
    buildUnitInit(id, model, team, hex, facing),
  );
  return new BattleController(quickstart(), inits, control, seed, mode);
}

function runAi(b: BattleController, limit = 3000): void {
  for (let i = 0; i < limit && b.result === null; i++) {
    if (!b.stepAi()) throw new Error(`no persona at prompt ${b.actorId}`);
  }
}

const ALL_AI: Record<string, PersonaKey> = {
  A1: "alpha",
  A2: "gladiator",
  B1: "longtom",
  B2: "pitfighter",
};

describe("Instant Action deployment (TW p. 256)", () => {
  it("rolls off 2D6 with ties re-rolled, the same for the same seed", () => {
    const a = rollOff(setupRng(42));
    const b = rollOff(setupRng(42));
    expect(a).toEqual(b);
    const last = a.rolls[a.rolls.length - 1]!;
    expect(last[0]).not.toBe(last[1]);
    expect(a.winner).toBe(last[0] > last[1] ? 1 : 2);
  });

  it("gives the loser the opposite edge and faces units into the map", () => {
    expect(oppositeEdge("north")).toBe("south");
    expect(oppositeEdge("west")).toBe("east");
    expect(inwardFacing("north")).toBe("s");
    expect(inwardFacing("south")).toBe("n");
  });

  it("auto-places on the home edge without stacking", () => {
    const map = quickstart();
    const south = autoPlace(map, "south", 4, new Set());
    expect(south).toHaveLength(4);
    expect(south.every((h) => h.row === map.height)).toBe(true);
    expect(new Set(south.map((h) => `${h.col},${h.row}`)).size).toBe(4);
    const taken = new Set(south.map((h) => `${h.col},${h.row}`));
    const more = autoPlace(map, "south", 3, taken);
    expect(more.some((h) => taken.has(`${h.col},${h.row}`))).toBe(false);
    expect(edgeHexes(map, "west")).toHaveLength(map.height);
  });
});

describe("Instant Action victory modes", () => {
  it("Annihilation ends with one side left in play", () => {
    const b = battle({ kind: "destroyAll" }, ALL_AI);
    runAi(b);
    expect(b.result).not.toBeNull();
    const r = b.result!;
    const alive = new Set(
      Object.values(b.state.units)
        .filter((u) => u.removed === "not")
        .map((u) => u.team),
    );
    expect(alive.size).toBeLessThanOrEqual(1);
    if (alive.size === 1) expect(r.winnerTeam).toBe([...alive][0]);
  });

  it("Attrition stops after turn N and the bigger damage dealer wins", () => {
    const b = battle({ kind: "damageRace", turns: 3 }, ALL_AI);
    runAi(b);
    const r = b.result!;
    expect(r.turn).toBeLessThanOrEqual(3);
    const [s1, s2] = r.sides;
    if (b.state.turn > 3 && s1!.dealt !== s2!.dealt) {
      expect(r.winnerTeam).toBe(s1!.dealt > s2!.dealt ? 1 : 2);
    }
    // dealt by one side is taken by the other
    expect(s1!.dealt).toBe(s2!.taken);
    expect(s2!.dealt).toBe(s1!.taken);
  });

  it("counts a removed unit's whole total", () => {
    const b = battle({ kind: "destroyAll" }, ALL_AI);
    const u = b.state.units.B1!;
    const whole = b.totals.B1!;
    expect(unitLoss(u, b.totals)).toBe(0);
    u.removed = "pilotEjected";
    expect(unitLoss(u, b.totals)).toBe(whole);
  });
});

describe("Instant Action debrief record", () => {
  it("keeps fire statistics, damage per turn and key moments, not the events", () => {
    const b = battle({ kind: "destroyAll" }, ALL_AI);
    runAi(b);
    const c = b.chronicle;
    expect(b.result!.decidedBy).toBe("elimination");
    for (const rec of Object.values(c.units)) {
      expect(rec.hits).toBeLessThanOrEqual(rec.shots);
      expect(rec.weapons.reduce((n, w) => n + w.shots, 0)).toBe(rec.shots);
      expect(rec.weapons.reduce((n, w) => n + w.hits, 0)).toBe(rec.hits);
    }
    // Damage per turn adds up to what each side's hits dealt.
    for (const team of [1, 2]) {
      const units = Object.values(b.state.units).filter((u) => u.team === team);
      const dealt = units.reduce((n, u) => n + c.units[u.id]!.dealt, 0);
      expect(c.perTurn[team]!.reduce((n, d) => n + d, 0)).toBe(dealt);
      expect(c.perTurn[team]!.length).toBeLessThanOrEqual(b.state.turn);
    }
    // Every unit out of play has a removal moment; kills go to enemies.
    const removed = Object.values(b.state.units).filter((u) => u.removed !== "not");
    expect(removed.length).toBeGreaterThan(0);
    for (const u of removed) {
      expect(c.moments.some((m) => m.kind === "removed" && m.unitId === u.id)).toBe(true);
    }
    for (const [id, rec] of Object.entries(c.units)) {
      for (const k of rec.kills) expect(b.state.units[k]!.team).not.toBe(b.state.units[id]!.team);
    }
    const first = c.moments.findIndex((m) => m.kind === "firstBlood");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(c.moments.filter((m) => m.kind === "firstBlood")).toHaveLength(1);
    // Moments come in turn order.
    const turns = c.moments.map((m) => m.turn);
    expect(turns).toEqual([...turns].sort((x, y) => x - y));
  });

  it("names what settled an Attrition result", () => {
    const b = battle({ kind: "damageRace", turns: 2 }, ALL_AI);
    runAi(b);
    const r = b.result!;
    const [s1, s2] = r.sides;
    if (r.decidedBy === "damage") expect(s1!.dealt).not.toBe(s2!.dealt);
    else if (r.decidedBy === "score") {
      expect(s1!.dealt).toBe(s2!.dealt);
      expect(s1!.score).not.toBe(s2!.score);
    } else if (r.decidedBy === "tie") expect(r.winnerTeam).toBeNull();
  });
});

describe("Instant Action debrief keys", () => {
  const key = (k: string, code = "") => debriefKey({ key: k, code } as KeyboardEvent);
  const next = () => key("]", "BracketRight");
  const prev = () => key("[", "BracketLeft");

  it("steps the sections with [ and ] (by key code), wrapping; Tab no longer does", () => {
    app.modal = null;
    app.tab = 0;
    expect(next()).toBe(true);
    expect(app.tab).toBe(1);
    expect(prev()).toBe(true);
    expect(prev()).toBe(true);
    expect(app.tab).toBe(6);
    expect(next()).toBe(true);
    expect(app.tab).toBe(0);
    expect(key("Tab")).toBe(false);
  });

  it("closes the menu with Esc or Backspace", () => {
    for (const k of ["Escape", "Backspace"]) {
      app.screen = "debrief";
      app.modal = { kind: "debriefMenu", cursor: 0 };
      expect(key(k)).toBe(true);
      expect(app.modal).toBeNull();
    }
  });

  it("has no shortcut keys for Rematch or Edit battle setup", () => {
    app.modal = null;
    app.screen = "debrief";
    expect(key("c", "KeyC")).toBe(false);
    expect(key("r", "KeyR")).toBe(false);
    expect(key("Enter")).toBe(false);
    expect(key(" ")).toBe(false);
    expect(app.modal).toBeNull();
    expect(app.screen).toBe("debrief");
  });

  it("runs the menu item under the cursor on Enter and Space alike", () => {
    for (const k of ["Enter", " "]) {
      app.screen = "debrief";
      expect(key("Escape")).toBe(true);
      expect(app.modal).toEqual({ kind: "debriefMenu", cursor: 0 });
      expect(key("ArrowUp")).toBe(true); // wraps to Options
      expect(key("ArrowUp")).toBe(true); // Back to title
      expect(key(k)).toBe(true);
      expect(app.modal).toBeNull();
      expect(app.screen).toBe("title");
    }
  });
});

describe("Instant Action input scheme", () => {
  const ev = (key: string, shiftKey = false) => ({ key, code: "", shiftKey }) as KeyboardEvent;

  it("reads Shift+Enter and Shift+Space as F10, and nothing else", () => {
    expect(commitAlias(ev("Enter", true)).key).toBe("F10");
    expect(commitAlias(ev(" ", true)).key).toBe("F10");
    const plain = ev("Enter");
    expect(commitAlias(plain)).toBe(plain);
    const tab = ev("Tab", true);
    expect(commitAlias(tab)).toBe(tab);
  });

  it("closes a message on A or B keys only", () => {
    for (const k of ["Enter", " ", "Escape", "Backspace"]) expect(closesMessage(ev(k))).toBe(true);
    for (const k of ["a", "ArrowDown", "F10", "Tab"]) expect(closesMessage(ev(k))).toBe(false);
  });

  it("runs an Esc menu with arrows and Enter / Space, closes it with Esc / Backspace", () => {
    let runs = 0;
    openMenu("M", [
      { label: () => "Stay", run: () => {} },
      { label: () => "Go", run: () => runs++ },
    ]);
    const m = () => app.modal as Extract<typeof app.modal, { kind: "menu" }>;
    expect(m().items).toHaveLength(2); // no Close entry: Esc / Backspace close
    expect(menuKey(ev("ArrowDown"), m())).toBe(true);
    expect(m().cursor).toBe(1);
    expect(menuKey(ev(" "), m())).toBe(true);
    expect(runs).toBe(1);
    expect(app.modal).toBeNull();
    for (const k of ["Escape", "Backspace"]) {
      openMenu("M", []);
      expect(menuKey(ev(k), m())).toBe(true);
      expect(app.modal).toBeNull();
    }
    openMenu("M", []);
    expect(menuKey(ev("a"), m())).toBe(false);
    app.modal = null;
  });

  describe("pick facing on a banded hex", () => {
    // a flat-top hex of circumradius 10 at the origin, corners at j·60° (y down)
    const poly = Array.from(
      { length: 6 },
      (_, j) => [10 * Math.cos((j * Math.PI) / 3), 10 * Math.sin((j * Math.PI) / 3)] as const,
    );
    const all: Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
    const N: [number, number] = [0, -7];
    const SE: [number, number] = [6, 3.5];

    it("takes the available triangle under the point", () => {
      expect(resolveFacing(poly, N, all, null)).toBe("n");
      expect(resolveFacing(poly, SE, all, null)).toBe("se");
    });

    it("off an available triangle, takes the nearest available facing", () => {
      expect(resolveFacing(poly, N, ["ne", "s"], null)).toBe("ne");
      expect(resolveFacing(poly, [0, 7], ["ne", "sw"], null)).toBe("sw");
      // equally near ne and nw: clockwise from the triangle under the point wins
      expect(resolveFacing(poly, N, ["ne", "nw"], null)).toBe("ne");
      // a banner point outside the hex still goes by angle
      expect(resolveFacing(poly, [0, -40], ["s", "nw"], null)).toBe("nw");
    });

    it("steps clockwise from the facing already chosen on the hex", () => {
      expect(resolveFacing(poly, N, all, "n")).toBe("ne");
      expect(resolveFacing(poly, N, ["n", "s"], "s")).toBe("n");
      expect(resolveFacing(poly, N, ["se"], "se")).toBe("se");
    });

    it("has no facing without an available one", () => {
      expect(resolveFacing(poly, N, [], null)).toBeNull();
    });
  });
});

describe("Instant Action debrief map pile tips", () => {
  it("names each wreck, severed limb and club in a hex", () => {
    const b = battle({ kind: "destroyAll" }, ALL_AI);
    runAi(b);
    const s = b.state;
    const u = Object.values(s.units).find((x) => x.removed !== "not")!;
    s.wreckage["30,30"] = [
      { unitId: u.id, model: u.model },
      { unitId: null, model: "XX-1" },
    ];
    s.clubs["30,30"] = [
      { kind: "limb", limb: "leftArm", model: u.model, ownerId: u.id },
      { kind: "girder" },
    ];
    expect(pileTip(s, "30,30")!.split("\n")).toEqual([
      `${u.id} ${u.model} · wreckage`,
      "XX-1 · wreckage",
      `${u.id} ${u.model} · severed LA`,
      "dropped girder club",
    ]);
    expect(pileTip(s, "31,31")).toBeNull();
  });
});

describe("Instant Action battle controller", () => {
  it("plays a player prompt through menu actions and lets the AI answer", () => {
    const b = battle(
      { kind: "destroyAll" },
      { A1: null, A2: "alpha", B1: "longtom", B2: "gladiator" },
    );
    for (let i = 0; i < 50 && b.actorPersona !== null; i++) b.stepAi();
    expect(b.actorId).toBe("A1");
    expect(b.phase).toBe("movement");
    expect(b.moveChoices()).toContain("walk");
    b.chooseMove("walk");
    const landing = b.move!.landings.find((l) => l.path.length > 0)!;
    b.chooseLanding(landing);
    b.commitMove();
    expect(b.state.units.A1!.position).toEqual(landing.hex);
  });

  it("rolls a rejected commit back: state, dice and actor unchanged", () => {
    const b = battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null });
    const actor = b.actorId;
    expect(() => b.chooseMove("standupWalk")).toThrow();
    b.chooseMove("walk");
    const step = {
      fragment: "F" as const,
      baseMp: 1,
      terrain: "clear" as const,
      terrainSurcharge: 0,
      climbLevels: 0,
      climbCost: 0,
    };
    const unit = b.actor!;
    // A path far beyond the walking MP: the engine rejects it.
    b.chooseLanding({
      hex: { col: unit.position.col, row: unit.position.row - 9 },
      facing: unit.facing,
      path: Array(9).fill(step),
    });
    const before = structuredClone(b.state);
    const chronicle = structuredClone(b.chronicle);
    const rng = b.rng.snapshot();
    expect(() => b.commitMove()).toThrow();
    expect(b.state).toEqual(before);
    expect(b.chronicle).toEqual(chronicle);
    expect(b.rng.snapshot()).toBe(rng);
    expect(b.actorId).toBe(actor);
  });

  it("checks weapons on a fireable target and passes an empty declaration", () => {
    const units: [string, string, 1 | 2, HexCoord, Facing][] = [
      ["A1", "HBK-4G", 1, { col: 7, row: 9 }, "n"],
      ["B1", "GRF-1N", 2, { col: 7, row: 6 }, "s"],
    ];
    const b = battle({ kind: "destroyAll" }, { A1: null, B1: null }, 7, units);
    let guard = 0;
    while (b.phase === "movement" && guard++ < 4) {
      b.chooseMove("standStill");
      b.commitMove();
    }
    expect(b.phase).toBe("attack");
    const target = b.fireSuggestion()!.targets[0]!;
    expect(b.attack!.targetId).toBe(target.targetId);
    const w = target.weapons[0]!;
    b.toggleWeapon(w.weaponIndex);
    expect(b.attack!.weapons).toEqual([w.weaponIndex]);
    b.toggleWeapon(w.weaponIndex);
    expect(b.attack!.weapons).toEqual([]);
    const actor = b.actorId;
    b.commitAttack();
    expect(b.actorId).not.toBe(actor);
  });

  it("persona never fires on a hull, even with no live enemy in reach", () => {
    // B2 is an ejected hull two hexes ahead; the live B1 is far out of range.
    const units: [string, string, 1 | 2, HexCoord, Facing][] = [
      ["A1", "HBK-4G", 1, { col: 4, row: 16 }, "n"],
      ["B1", "GRF-1N", 2, { col: 12, row: 1 }, "s"],
      ["B2", "ENF-4R", 2, { col: 4, row: 14 }, "s"],
    ];
    const b = battle({ kind: "destroyAll" }, { A1: "alpha", B1: null, B2: null }, 7, units);
    b.state.units.B2!.removed = "pilotEjected";
    // Play turn 1 out: A1 has only the hull in reach, the humans pass.
    for (let i = 0; i < 40 && b.state.turn === 1 && b.result === null; i++) {
      if (b.actorPersona !== null) b.stepAi();
      else if (b.phase === "movement") {
        b.chooseMove("standStill");
        b.commitMove();
      } else b.commitAttack();
    }
    expect(b.state.turn).toBe(2);
    expect(b.log.filter((l) => l.text.includes("→ B2"))).toEqual([]);
  });
});

describe("Instant Action battle keys", () => {
  const key = (k: string, shiftKey = false) =>
    battleKey({ key: k, code: "", shiftKey } as KeyboardEvent);
  const setUp = (b: BattleController) => {
    app.screen = "title"; // keeps persona pumping off the test
    app.battle = b;
    app.battleUi = newBattleUi();
    app.modal = null;
    app.playerSince = -1e9;
  };
  const attackBattle = () => {
    const units: [string, string, 1 | 2, HexCoord, Facing][] = [
      ["A1", "HBK-4G", 1, { col: 7, row: 9 }, "n"],
      ["B1", "GRF-1N", 2, { col: 7, row: 6 }, "s"],
    ];
    const b = battle({ kind: "destroyAll" }, { A1: null, B1: null }, 7, units);
    for (let i = 0; i < 4 && b.phase === "movement"; i++) {
      b.chooseMove("standStill");
      b.commitMove();
    }
    return b;
  };

  it("cycles the key focus left sheet, orders, right sheet with Tab / Shift+Tab", () => {
    setUp(battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null }));
    expect(key("Tab")).toBe(true);
    expect(app.battleUi.focus).toBe(1);
    expect(key("Tab")).toBe(true);
    expect(app.battleUi.focus).toBe(0);
    expect(key("Tab", true)).toBe(true);
    expect(app.battleUi.focus).toBe(1);
    expect(key("Backspace")).toBe(true); // back to the orders
    expect(app.battleUi.focus).toBe("orders");
  });

  describe("record sheet policy", () => {
    const sheets = () => app.battleUi.sheets.map((d) => (d.open ? d.unitId : null));

    it("shows the mover left and closes the right drawer, Player or persona", () => {
      for (const control of [{ A1: null }, { A1: "alpha" as const }]) {
        const b = battle({ kind: "destroyAll" }, { A2: null, B1: null, B2: null, ...control });
        setUp(b);
        app.battleUi.sheets[1] = { open: true, unitId: "B1", pinned: false };
        sheetPolicy();
        expect(b.phase).toBe("movement");
        expect(sheets()).toEqual([b.actorId, null]);
      }
    });

    it("shows the target right and closes the left drawer in the attack phase", () => {
      const b = attackBattle();
      setUp(b);
      app.battleUi.sheets[0] = { open: true, unitId: "A1", pinned: false };
      sheetPolicy();
      expect(b.phase).toBe("attack");
      expect(sheets()).toEqual([null, b.attack!.targetId]);
      // a manual open holds until the next actor or target
      app.battleUi.sheets[0].open = true;
      sheetPolicy();
      expect(sheets()).toEqual(["A1", b.attack!.targetId]);
    });

    it("leaves a pinned drawer as it is", () => {
      const b = attackBattle();
      setUp(b);
      app.battleUi.sheets[0] = { open: true, unitId: "B1", pinned: false };
      expect(battleKey({ key: "{", code: "BracketLeft", shiftKey: true } as KeyboardEvent)).toBe(
        true,
      );
      expect(app.battleUi.sheets[0]).toMatchObject({ open: true, pinned: true });
      sheetPolicy();
      expect(sheets()).toEqual(["B1", b.attack!.targetId]);
      expect(app.battleUi.sheets[0].pinned).toBe(true);
    });
  });

  it("starts the movement bar on Hold and walks Control, Hold, Move to hex with ← →", () => {
    const b = battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null });
    setUp(b);
    const cursor = () => app.battleUi.moveItem?.item;
    expect(app.battleUi.moveItem).toBeNull(); // the default: Hold
    expect(key("ArrowRight")).toBe(true);
    expect(cursor()).toBe("hex");
    expect(key("ArrowRight")).toBe(true); // round again
    expect(cursor()).toBe("control");
    expect(key("ArrowLeft")).toBe(true);
    expect(cursor()).toBe("hex");
    expect(key("ArrowLeft")).toBe(true);
    expect(cursor()).toBe("hold");
    expect(key("F10")).toBe(false); // nothing chosen: nothing commits
    expect(b.move!.choice).toBeNull();
  });

  it("Control: a persona picked for the move hides the bar, F10 lets it play this phase only", () => {
    const b = battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null });
    setUp(b);
    const mover = b.actorId!;
    b.chooseMove("walk");
    b.setPhasePersona("longtom");
    expect(b.phasePersona).toBe("longtom");
    expect(key("ArrowRight")).toBe(true); // Control is the only dropdown left
    expect(app.battleUi.moveItem?.item).toBe("control");
    b.setPhasePersona(null); // back to the Player: the draft is still there
    expect(b.move!.choice).toBe("walk");
    b.setPhasePersona("longtom");
    expect(key("F10")).toBe(true);
    expect(b.actorId).not.toBe(mover);
    expect(b.phasePersona).toBeNull(); // lapsed with the prompt
    expect(b.actorPersona).toBeNull(); // still a Player unit
  });

  it("Control: a persona picked for the attack hides the panel rows and fires on F10", () => {
    const b = attackBattle();
    setUp(b);
    const shooter = b.actorId;
    b.setPhasePersona("alpha");
    expect(key("ArrowDown")).toBe(true); // only the Control row is left
    expect(app.battleUi.attackRow?.row).toBe("control");
    expect(key("F10")).toBe(true);
    expect(b.actorId === shooter && b.phase === "attack").toBe(false);
    expect(b.phasePersona).toBeNull();
  });

  it("Control: refused for a persona unit", () => {
    const b = battle(
      { kind: "destroyAll" },
      { A1: "alpha", A2: "alpha", B1: "alpha", B2: "alpha" },
    );
    expect(b.actorPersona).not.toBeNull();
    expect(() => b.setPhasePersona("longtom")).toThrow(/persona/);
    expect(() => b.commitPhasePersona()).toThrow();
  });

  /** A1 with B1 and B2 both adjacent in its front arc, at A1's attack. */
  const meleeBattle = () => {
    const units: [string, string, 1 | 2, HexCoord, Facing][] = [
      ["A1", "HBK-4G", 1, { col: 7, row: 9 }, "n"],
      ["B1", "GRF-1N", 2, { col: 7, row: 8 }, "s"],
      ["B2", "ENF-4R", 2, { col: 8, row: 9 }, "sw"],
    ];
    const b = battle({ kind: "destroyAll" }, { A1: null, B1: null, B2: null }, 7, units);
    for (let i = 0; i < 12 && !(b.phase === "attack" && b.actorId === "A1"); i++) {
      if (b.phase === "movement") {
        b.chooseMove("standStill");
        b.commitMove();
      } else b.commitAttack();
    }
    expect(b.actorId).toBe("A1");
    return b;
  };
  const dialog = () => app.modal as { kind: "fire" | "physical"; cursor: number };
  /** Twist (where the panel starts) → Weapon Target → the weapons button. */
  const toWeapons = () => {
    expect(key("ArrowDown")).toBe(true);
    expect(key("ArrowDown")).toBe(true);
    expect(app.battleUi.attackRow?.row).toBe("weapons");
  };

  describe("Attack Command panel", () => {
    it("starts on Twist under Control; ↑ ↓ walk the rows, ← → act per row", () => {
      const b = attackBattle();
      setUp(b);
      expect(b.phase).toBe("attack");
      const target = b.attack!.targetId;
      expect(app.battleUi.attackRow).toBeNull();
      expect(key("ArrowRight")).toBe(true); // Twist: one to the right
      expect(b.attack!.twist).toBe("rightSide");
      expect(key("ArrowLeft")).toBe(true);
      expect(b.attack!.twist).toBe("front");
      expect(key("ArrowDown")).toBe(true);
      expect(app.battleUi.attackRow?.row).toBe("target");
      expect(key("ArrowRight")).toBe(true);
      expect(b.attack!.twist).toBe("front"); // cycles the target, not the twist
      expect(b.attack!.targetId).toBe(target); // only one target
      expect(key("ArrowUp")).toBe(true);
      expect(app.battleUi.attackRow?.row).toBe("twist");
      expect(key("ArrowLeft")).toBe(true); // Left, Front, Right as shown
      expect(b.attack!.twist).toBe("leftSide");
      expect(key("Enter")).toBe(true); // one to the right
      expect(b.attack!.twist).toBe("front");
      expect(key("ArrowUp")).toBe(true);
      expect(app.battleUi.attackRow?.row).toBe("control");
      expect(key("ArrowRight")).toBe(true); // nothing to step on Control
      expect(b.attack!.twist).toBe("front");
      expect(key("ArrowUp")).toBe(true); // wraps to the last row
      expect(app.battleUi.attackRow?.row).toBe("weapons"); // nobody adjacent: no physical row
    });

    it("opens the weapon dialog; Enter checks and moves on, Esc keeps the checks", () => {
      const b = attackBattle();
      setUp(b);
      const fireable = b.fireSuggestion()!.targets[0]!.weapons.map((w) => w.weaponIndex);
      expect(fireable.length).toBeGreaterThan(1);
      toWeapons();
      expect(key("Enter")).toBe(true);
      expect(dialog()).toEqual({ kind: "fire", cursor: 0 });
      expect(key("Enter")).toBe(true);
      expect(dialog().cursor).toBe(1);
      expect(key(" ")).toBe(true);
      expect(b.attack!.weapons).toEqual(fireable.slice(0, 2));
      expect(key("Escape")).toBe(true);
      expect(app.modal).toBeNull();
      expect(b.attack!.weapons).toEqual(fireable.slice(0, 2));
    });

    it("skips blocked weapon rows with ↑ ↓", () => {
      const b = attackBattle();
      setUp(b);
      const t0 = b.fireSuggestion()!.targets[0]!;
      toWeapons();
      expect(key("Enter")).toBe(true);
      expect(key("ArrowUp")).toBe(true); // wraps past any blocked rows to the last fireable one
      expect(dialog().cursor).toBe(t0.weapons.length - 1);
    });

    it("lists physical attacks on every adjacent enemy: a punch at each of two targets", () => {
      const b = meleeBattle();
      setUp(b);
      const opts = b.physicalOptions();
      const punches = ["B1", "B2"].map((id) =>
        opts.find((o) => o.decl.type === "punch" && o.decl.targetId === id),
      );
      expect(punches.every((p) => p !== undefined)).toBe(true);
      const [p1, p2] = punches as [(typeof opts)[number], (typeof opts)[number]];
      // two arms, two targets
      const other = opts.find(
        (o) => o.decl.type === "punch" && o.decl.targetId === "B2" && o.decl.limb !== p1.decl.limb,
      );
      expect(other).toBeDefined();
      b.togglePhysical(p1.decl);
      expect(b.physicalConflict(other!.decl)).toBeNull();
      b.togglePhysical(other!.decl);
      expect(b.attack!.physical).toHaveLength(2);
      // the same arm again, a kick: they show why not
      const sameArm = opts.find(
        (o) =>
          o.decl.type === "punch" &&
          o.decl.limb === other!.decl.limb &&
          o.decl.targetId !== other!.decl.targetId,
      );
      expect(sameArm).toBeDefined();
      expect(b.physicalConflict(sameArm!.decl)).toBe("armInUse");
      const kick = opts.find((o) => o.decl.type === "kick");
      expect(kick).toBeDefined();
      expect(b.physicalConflict(kick!.decl)).toBe("oneType");
      expect(p2).toBeDefined();
      expect(() => b.commitAttack()).not.toThrow();
    });

    it("opens the physical dialog from its button; a checked punch blocks its arm's weapons", () => {
      const b = meleeBattle();
      setUp(b);
      expect(key("ArrowDown")).toBe(true); // twist → target
      expect(key("ArrowDown")).toBe(true); // → weapons
      expect(key("ArrowDown")).toBe(true); // → physical
      expect(app.battleUi.attackRow?.row).toBe("physical");
      expect(key("Enter")).toBe(true);
      expect(dialog().kind).toBe("physical");
      const opts = b.physicalOptions();
      const punch = opts.find((o) => o.decl.type === "punch")!;
      b.togglePhysical(punch.decl);
      const def = mechDefFor(b.actor!);
      const armGun = Object.entries(def.weapons).find(([, w]) => w.location === punch.decl.limb);
      expect(armGun).toBeDefined();
      expect(b.weaponConflict(Number(armGun![0]))).toBe("punching");
      expect(key("Backspace")).toBe(true);
      expect(app.modal).toBeNull();
      expect(b.attack!.physical).toHaveLength(1);
    });

    it("changing the weapon target keeps the physical checks", () => {
      const b = meleeBattle();
      setUp(b);
      const punch = b.physicalOptions().find((o) => o.decl.type === "punch")!;
      b.togglePhysical(punch.decl);
      const ids = b.fireSuggestion()!.targets.map((x) => x.targetId);
      const other = ids.find((id) => id !== b.attack!.targetId);
      expect(other).toBeDefined();
      b.setTarget(other!);
      expect(b.attack!.physical).toHaveLength(1);
    });

    it("frames the shooter and the weapon target once per attack, every turn", () => {
      const b = attackBattle();
      setUp(b);
      frameTarget();
      expect(app.battleUi.framePending).toBe(true);
      app.battleUi.framePending = false;
      frameTarget();
      expect(app.battleUi.framePending).toBe(false); // same attack: once
      b.state.turn++; // the same actor and target on a later turn frames again
      frameTarget();
      expect(app.battleUi.framePending).toBe(true);
    });

    it("hides the Club row with no club action", () => {
      const b = attackBattle();
      setUp(b);
      expect(b.clubActions()).toEqual([]);
      expect(b.clubAction()).toBe("none");
    });
  });

  it("lists Policies for an acting Player unit and Options last; ← → step the pace and animations", () => {
    const pace = app.aiPace;
    setUp(battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null }));
    expect(key("Escape")).toBe(true);
    expect(app.modal).toEqual({ kind: "battleMenu", cursor: 0 });
    expect(key("ArrowDown")).toBe(true);
    const before = app.aiPace;
    expect(key("ArrowRight")).toBe(true);
    expect(app.aiPace).not.toBe(before);
    expect(key("ArrowLeft")).toBe(true);
    expect(app.aiPace).toBe(before);
    const anim = app.anim;
    expect(key("ArrowDown")).toBe(true); // Animations
    expect(key("ArrowRight")).toBe(true);
    expect(app.anim).not.toBe(anim);
    expect(key("ArrowLeft")).toBe(true);
    expect(app.anim).toBe(anim);
    expect(key("ArrowDown")).toBe(true);
    expect(key("Enter")).toBe(true); // Policies
    expect(app.modal?.kind).toBe("policy");
    expect(key("Escape")).toBe(true); // back to the menu, on Policies
    expect(app.modal).toEqual({ kind: "battleMenu", cursor: 3 });
    expect(key("ArrowUp")).toBe(true);
    expect(key("ArrowUp")).toBe(true);
    expect(key("ArrowUp")).toBe(true);
    expect(key("ArrowUp")).toBe(true); // wraps to Options, after Withdraw
    expect(key("Enter")).toBe(true);
    expect(app.modal).toEqual({
      kind: "options",
      cursor: 0,
      back: { kind: "battleMenu", cursor: 5 },
    });
    expect(key("Backspace")).toBe(true); // back to the menu, on Options
    expect(app.modal).toEqual({ kind: "battleMenu", cursor: 5 });
    app.modal = null;
    setAiPace(pace);
    setAnimSpeed(anim);
  });
});

describe("Instant Action map animation beats", () => {
  function steps(seed: number): StepRecord[] {
    const b = battle({ kind: "destroyAll" }, ALL_AI, seed);
    const out: StepRecord[] = [];
    b.onStep = (s) => out.push(s);
    runAi(b);
    return out;
  }

  it("records every persona commit with the battle it found", () => {
    const recs = steps(42);
    expect(recs.length).toBeGreaterThan(10);
    expect(recs.every((r) => r.persona)).toBe(true);
    expect(recs.some((r) => r.move !== null)).toBe(true);
  });

  it("replays a move to where the engine left the unit", () => {
    for (const r of steps(42)) {
      const moved = r.events.find((e) => e.kind === "moved");
      if (moved?.kind !== "moved" || !r.move) continue;
      const beat = buildBeats(r.events, r.move).find((x) => x.kind === "move" || x.kind === "jump");
      if (!beat) continue;
      if (beat.kind === "jump") {
        expect(beat.to).toEqual(moved.position);
        expect(beat.facing).toBe(moved.facing);
        continue;
      }
      if (beat.kind !== "move") continue;
      let hex = r.move.from;
      let facing = r.move.facing;
      for (const l of beat.legs) {
        if (l.kind === "enter") {
          expect(l.from).toEqual(hex);
          hex = l.to;
        } else {
          expect(l.from).toBe(facing);
          facing = l.to;
        }
      }
      expect(hex).toEqual(moved.position);
      expect(facing).toBe(moved.facing);
    }
  });

  it("groups the attack resolution into volleys, one per attacker and target", () => {
    const reels = steps(42)
      .map((r) => buildBeats(r.events, r.move))
      .filter(isReel);
    expect(reels.length).toBeGreaterThan(0);
    for (const beats of reels) {
      const volleys = beats.filter((x) => x.kind === "volley");
      for (const v of volleys) {
        if (v.kind !== "volley") continue;
        expect(v.shots.length).toBeGreaterThan(0);
        for (const s of v.shots) expect(s.hit ? s.damage > 0 : s.damage === 0).toBe(true);
      }
      const keys = volleys.map((v) => (v.kind === "volley" ? `${v.attackerId}>${v.targetId}` : ""));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("names what a clip plays for the orders panel", () => {
    let reels = 0;
    let moves = 0;
    for (const r of steps(42)) {
      const beats = buildBeats(r.events, r.move);
      const st = clipStatus(beats);
      if (isReel(beats)) {
        reels++;
        expect(st).toEqual({ kind: "reel" });
      } else if (r.move && beats.some((x) => x.kind === "move" || x.kind === "jump")) {
        moves++;
        expect(st && st.kind !== "reel" && st.unitId).toBe(r.actorId);
      }
    }
    expect(reels).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(0);
    expect(clipStatus([])).toBeNull();
  });

  it("pauses a clip's clock and runs it on from there", () => {
    const r = steps(42).find((x) => x.move && x.events.some((e) => e.kind === "moved"));
    const beats = buildBeats(r!.events, r!.move);
    const view = {
      banners: [],
      poses: new Map(),
      fx: {},
      onFrame: null as ((now: number) => boolean) | null,
      wake: vi.fn(),
    };
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const a = new MapAnimator();
      const input = { banners: [], beats, k: 1, reduced: true, sub: () => null };
      a.play(view as unknown as MapView, input);
      expect(a.busy).toBe(true);
      now = 1050;
      expect(view.onFrame!(now)).toBe(true);
      expect(a.status?.kind).toBe(beats.some((x) => x.kind === "jump") ? "jump" : "move");
      a.pause();
      now = 60_000; // far past the clip's end, but the clock is stopped
      expect(view.onFrame!(now)).toBe(false);
      expect(a.busy && a.paused).toBe(true);
      a.resume();
      expect(a.paused).toBe(false);
      expect(view.wake).toHaveBeenLastCalledWith(true);
      expect(view.onFrame!(now + 10)).toBe(true); // 60 ms into the clip again
      expect(view.onFrame!(now + 10_000)).toBe(false);
      expect(a.busy).toBe(false);
      expect(a.status).toBeNull();
      a.play(view as unknown as MapView, input);
      a.pause();
      a.skip(); // ends a paused clip too
      expect(a.busy || a.paused).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("caps a move at 1.6 s and a volley at 1.5 s at Full", () => {
    const legs = Array.from({ length: 30 }, (_, i) => ({
      kind: "enter" as const,
      from: { col: 1, row: i + 1 },
      to: { col: 1, row: i + 2 },
    }));
    const total = legTimes(legs, "walk").reduce((a, x) => a + x, 0);
    expect(total).toBeCloseTo(1600);
    expect(legTimes(legs.slice(0, 3), "walk")).toEqual([160, 160, 160]);
    expect(legTimes(legs.slice(0, 3), "run")).toEqual([110, 110, 110]);
    const shots = Array.from({ length: 20 }, () => ({}));
    const volley = beatTime({
      kind: "volley",
      attackerId: "A1",
      targetId: "B1",
      shots: shots as never,
      after: { armor: {}, armorRear: {}, internalStructure: {} } as never,
    });
    expect(volley).toBeLessThanOrEqual(1500);
  });
});

describe("Instant Action unit sign", () => {
  const look = {
    pilotHits: 0,
    pilotMax: 6,
    prone: false,
    off: false,
    hull: false,
    destroyed: false,
  };
  it("shows the pilot's health, one box per hit it can still take", () => {
    expect(bannerSub(look)).toBe("▮▮▮▮▮▮");
    expect(bannerSub({ ...look, pilotHits: 2 })).toBe("▮▮▮▮▯▯");
    expect(bannerSub({ ...look, pilotHits: 1, pilotMax: 8 })).toBe("▮▮▮▮▮▮▮▯");
    expect(bannerSub({ ...look, pilotHits: 9 })).toBe("▯▯▯▯▯▯");
    expect(bannerSub({ ...look, pilotHits: 4, prone: true })).toBe("PRN ▮▮");
    expect(bannerSub({ ...look, off: true })).toBe("OFF");
  });
});

describe("Instant Action camera policy (docs/INSTANT.md, Camera)", () => {
  const hex = (col: number, row: number): HexCoord => ({ col, row });
  const before = {
    units: { A1: { position: hex(1, 1) }, B1: { position: hex(5, 5) } },
  } as unknown as Parameters<typeof clipNeeds>[1];

  it("must show every hex of a move with its sign, and attacks from where the clip left units", () => {
    const beats: Beat[] = [
      {
        kind: "move",
        unitId: "A1",
        mode: "walk",
        legs: [
          { kind: "enter", from: hex(1, 1), to: hex(1, 2) },
          { kind: "turn", from: "n", to: "ne" },
          { kind: "enter", from: hex(1, 2), to: hex(2, 2) },
        ],
      },
      {
        kind: "volley",
        attackerId: "A1",
        targetId: "B1",
        shots: [],
        after: {} as never,
      },
    ];
    const [move, volley] = clipNeeds(beats, before);
    expect(move!.needs.map((n) => n.hex)).toEqual([hex(1, 1), hex(1, 2), hex(1, 2), hex(2, 2)]);
    expect(move!.needs.every((n) => n.sign === "A1")).toBe(true);
    expect(move!.needs.at(-1)!.tick).toBe(true);
    // A1 shoots from its landing; the target's ticker column counts
    expect(volley!.needs).toEqual([
      { hex: hex(2, 2), sign: "A1", tick: false },
      { hex: hex(5, 5), sign: "B1", tick: true },
    ]);
  });

  it("leaves headroom for a jump's arc", () => {
    const [jump] = clipNeeds(
      [
        {
          kind: "jump",
          unitId: "A1",
          from: hex(1, 1),
          to: hex(3, 3),
          fromFacing: "n",
          facing: "s",
          hexes: 3,
        },
      ],
      before,
    );
    expect(jump!.needs.map((n) => [n.hex, n.lift])).toEqual([
      [hex(1, 1), JUMP_LIFT],
      [hex(3, 3), JUMP_LIFT],
    ]);
  });

  it("finds the clear rectangles between the overlays", () => {
    const bound = { x0: 0, y0: 0, x1: 1000, y1: 600 };
    const drawer = { x0: 0, y0: 50, x1: 250, y1: 550 };
    const orders = { x0: 400, y0: 0, x1: 600, y1: 60 };
    const done = { x0: 420, y0: 520, x1: 580, y1: 600 };
    const rects = emptyRects(bound, [drawer, orders, done]);
    expect(rects[0]).toEqual({ x0: 250, y0: 60, x1: 1000, y1: 520 });
    for (const r of rects)
      for (const o of [drawer, orders, done])
        expect(o.x0 < r.x1 && o.x1 > r.x0 && o.y0 < r.y1 && o.y1 > r.y0).toBe(false);
    expect(emptyRects(bound, [])).toEqual([bound]);
  });

  it("follows a reel: the camera runs before each attack and the clip waits for it", () => {
    const shot = {
      weapon: "Medium Laser",
      look: "beam" as const,
      hit: false,
      damage: 0,
      locations: [],
      crit: false,
      jammed: false,
      after: {} as never,
    };
    const beats: Beat[] = [
      { kind: "volley", attackerId: "A1", targetId: "B1", shots: [shot], after: {} as never },
      { kind: "volley", attackerId: "B1", targetId: "A1", shots: [shot], after: {} as never },
    ];
    const view = { banners: [], poses: new Map(), fx: {}, onFrame: null, wake: vi.fn() };
    const end = (a: MapAnimator) => (a as unknown as { clip: { end: number } }).clip.end;
    const base = { banners: [], beats, k: 1, reduced: true, sub: () => null };
    const plain = new MapAnimator();
    plain.play(view as unknown as MapView, base);
    const run = vi.fn();
    const follow = new MapAnimator();
    follow.play(view as unknown as MapView, {
      ...base,
      follow: { picks: (b) => b.kind === "volley", run, gap: 250 },
    });
    expect(end(follow)).toBe(end(plain) + 500);
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      follow.delayStart(100);
      now += 50;
      (view.onFrame as unknown as (n: number) => boolean)(now);
      expect(run).not.toHaveBeenCalled(); // held for the camera
      now += 100;
      (view.onFrame as unknown as (n: number) => boolean)(now);
      expect(run).toHaveBeenCalledTimes(1);
      now += 60_000;
      (view.onFrame as unknown as (n: number) => boolean)(now);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
      plain.skip();
    }
  });
});

describe("Instant Action Options", () => {
  const ev = (key: string) => ({ key, code: "", shiftKey: false }) as KeyboardEvent;
  const opts = () => app.modal as Extract<typeof app.modal, { kind: "options" }>;
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    app.modal = null;
  });

  it("is the title menu's third item and opens over nothing", () => {
    const items = titleItems();
    expect(items.map((it) => it.label)).toEqual(["title.new", "title.random", "title.options"]);
    items[2]!.run();
    expect(app.modal).toEqual({ kind: "options", cursor: 0, back: null });
    expect(titleKey(ev("Escape"))).toBe(true);
    expect(app.modal).toBeNull();
    expect(titleKey(ev("Escape"))).toBe(false); // no title Esc menu any more
    expect(app.modal).toBeNull();
  });

  it("steps pace with ← → and toggles the reasoning log and glyph avatars, keeping them", () => {
    const pace = app.aiPace;
    const reasoning = app.aiReasoning;
    const glyphs = app.glyphs;
    openOptions(null);
    expect(optionsKey(ev("ArrowDown"), opts())).toBe(true); // Persona pace
    expect(optionsKey(ev("ArrowRight"), opts())).toBe(true);
    expect(app.aiPace).not.toBe(pace);
    expect(store.get("bt10x.instant.pace")).toBe(app.aiPace);
    expect(optionsKey(ev("ArrowLeft"), opts())).toBe(true);
    expect(app.aiPace).toBe(pace);
    expect(optionsKey(ev("ArrowDown"), opts())).toBe(true); // reasoning log
    expect(optionsKey(ev("Enter"), opts())).toBe(true);
    expect(app.aiReasoning).toBe(!reasoning);
    expect(store.get("bt10x.instant.reasoning")).toBe(reasoning ? "off" : "on");
    expect(optionsKey(ev(" "), opts())).toBe(true);
    expect(app.aiReasoning).toBe(reasoning);
    expect(optionsKey(ev("ArrowDown"), opts())).toBe(true); // glyph avatars
    expect(optionsKey(ev("Enter"), opts())).toBe(true);
    expect(app.glyphs).toBe(!glyphs);
    expect(store.get("bt10x.instant.glyphs")).toBe(glyphs ? "off" : "on");
    expect(optionsKey(ev("ArrowDown"), opts())).toBe(true); // wraps to Language
    expect(opts().cursor).toBe(0);
    expect(optionsKey(ev("a"), opts())).toBe(false);
    setAiPace(pace);
    setAiReasoning(reasoning);
    setGlyphs(glyphs);
  });

  it("ends each Esc menu, and closing it returns to that menu on its row", () => {
    openMenu("M", [{ label: () => "Done", run: () => {} }, ...prefItems()]);
    const menu = app.modal;
    expect(menuKey(ev("ArrowDown"), menu as Extract<typeof menu, { kind: "menu" }>)).toBe(true);
    expect(menuKey(ev("Enter"), menu as Extract<typeof menu, { kind: "menu" }>)).toBe(true);
    expect(opts().back).toBe(menu);
    for (const k of ["Escape", "Backspace"]) {
      app.modal = { kind: "options", cursor: 2, back: menu };
      expect(menuKey(ev(k), opts())).toBe(true);
      expect(app.modal).toBe(menu);
      expect(menu).toMatchObject({ kind: "menu", cursor: 1 });
    }
  });

  it("ends the debrief menu too", () => {
    app.screen = "debrief";
    app.modal = { kind: "debriefMenu", cursor: 3 };
    expect(debriefKey(ev("Enter"))).toBe(true);
    expect(app.modal).toEqual({
      kind: "options",
      cursor: 0,
      back: { kind: "debriefMenu", cursor: 3 },
    });
    expect(debriefKey(ev("Escape"))).toBe(true);
    expect(app.modal).toEqual({ kind: "debriefMenu", cursor: 3 });
  });

  it("logs each persona decision only with the reasoning log on", () => {
    const reasoned = (on: boolean) => {
      const b = battle({ kind: "destroyAll" }, ALL_AI);
      b.reasoning = on;
      expect(b.stepAi()).toBe(true);
      return b.log.filter((l) => l.text.startsWith("Persona "));
    };
    expect(reasoned(false)).toEqual([]);
    expect(reasoned(true)).toHaveLength(1);
  });
});

describe("Instant Action plays the same battle as the terminal", () => {
  // Same logic, own copy: with the same seed, positions and personas the two
  // apps must reach the same end state (only the presentation differs).
  it.each([42, 2])("seed %i", (seed) => {
    const b = battle({ kind: "destroyAll" }, ALL_AI, seed);
    runAi(b);
    const s = newSession(seed);
    runChunks(s, "map quickstart");
    for (const u of Object.values(b.state.units)) {
      const init = { A1: [4, 16, "n"], A2: [12, 16, "n"], B1: [4, 1, "s"], B2: [12, 1, "s"] }[
        u.id
      ]!;
      runChunks(s, `add ${u.id} ${u.model} ${init[0]} ${init[1]} ${init[2]}`);
      runChunks(s, `set ${u.id} team ${u.team}`);
    }
    for (const [id, p] of Object.entries(ALL_AI)) runChunks(s, `pp ${id} ${p}`);
    runChunks(s, "start");
    expect(s.over?.victory.winnerTeam).toBe(b.result?.winnerTeam);
    expect(s.battle!.turn).toBe(b.state.turn);
    const view = (units: typeof b.state.units) =>
      Object.values(units).map((u) => [u.id, u.position, u.facing, u.damage, u.removed]);
    expect(view(s.battle!.units)).toEqual(view(b.state.units));
  });
});

describe("Instant Action setup", () => {
  it("filters the catalog like info mech (class, tech, text)", () => {
    const f = { ...defaultFilter(), classes: ["assault" as const], tech: "is" as const };
    const list = filterMechs(f);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => m.tonnage >= 80)).toBe(true);
    expect(
      filterMechs({ ...defaultFilter(), text: "hunchback" }).every((m) =>
        /hunchback/i.test(m.name),
      ),
    ).toBe(true);
  });

  it("generates a side near a BV target", () => {
    const slots = generateSide(createRng(5), {
      count: 3,
      bvTarget: 4000,
      classes: [],
      personas: "random",
    });
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.persona !== null)).toBe(true);
  });

  it("New battle starts empty and blocks launch until map and engagement are set", () => {
    const l = emptyLoadout();
    expect(l.sides).toEqual([[], []]);
    expect(loadoutProblem(l)?.key).toBe("err.emptySide");
    l.sides[0].push(addedSlot(createRng(1), l, 0)!);
    l.sides[1].push(addedSlot(createRng(2), l, 1)!);
    expect(loadoutProblem(l)?.key).toBe("err.noMap");
    l.map = "quickstart";
    expect(loadoutProblem(l)?.key).toBe("err.noMode");
    l.mode = { kind: "destroyAll" };
    expect(loadoutProblem(l)).toBeNull();
  });

  it("[+] adds a persona slot BV-matched to the opponent's average", () => {
    const l = emptyLoadout();
    const first = addedSlot(createRng(3), l, 0)!;
    expect(first).toMatchObject({ id: "A1", gunnery: 4, piloting: 5, pilotHitMax: 6 });
    expect(first.persona).not.toBeNull();
    l.sides[0].push(first, addedSlot(createRng(4), l, 0)!);
    const avg = (bvOf(l.sides[0][0]!.model) + bvOf(l.sides[0][1]!.model)) / 2;
    for (let seed = 0; seed < 20; seed++) {
      const s = addedSlot(createRng(seed), l, 1)!;
      expect(s.id).toBe("B1");
      expect(s.persona).not.toBeNull();
      expect(bvOf(s.model)).toBeGreaterThanOrEqual(avg * 0.9);
      expect(bvOf(s.model)).toBeLessThanOrEqual(avg * 1.1);
    }
  });

  describe("Choose Control dialog", () => {
    const ev = (key: string) => ({ key, code: "", shiftKey: false }) as KeyboardEvent;
    const open = () => {
      const l = emptyLoadout();
      l.sides[0].push(addedSlot(createRng(1), l, 0)!);
      app.loadout = l;
      app.modal = personaModal(0, 0);
      return {
        slot: l.sides[0][0]!,
        m: app.modal as Extract<typeof app.modal, { kind: "persona" }>,
      };
    };
    afterEach(() => {
      app.modal = null;
    });

    it("opens on the slot's current control and lists Player first", () => {
      expect(CONTROLS).toEqual([null, ...PERSONA_KEYS]);
      const { slot, m } = open();
      expect(CONTROLS[m.cursor]).toBe(slot.persona);
      expect(m.focusList).toBe(true);
    });

    it("Enter uses the highlighted control; Esc and Backspace keep the old one", () => {
      for (const k of ["Escape", "Backspace"]) {
        const { slot, m } = open();
        const before = slot.persona;
        expect(personaKey(ev("End"), m)).toBe(true);
        expect(personaKey(ev(k), m)).toBe(true);
        expect(app.modal).toBeNull();
        expect(slot.persona).toBe(before);
      }
      const { slot, m } = open();
      expect(personaKey(ev("End"), m)).toBe(true);
      expect(personaKey(ev("Enter"), m)).toBe(true);
      expect(app.modal).toBeNull();
      expect(slot.persona).toBe("dispossessed");
      const again = open();
      again.slot.persona = "alpha";
      app.modal = personaModal(0, 0);
      const m2 = app.modal as Extract<typeof app.modal, { kind: "persona" }>;
      expect(personaKey(ev("Home"), m2)).toBe(true);
      expect(personaKey(ev(" "), m2)).toBe(true);
      expect(again.slot.persona).toBeNull(); // Player
      expect(personaKey(ev("a"), m2)).toBe(false);
    });

    it("reads the detail from the persona table", () => {
      const facts = (k: PersonaKey) =>
        Object.fromEntries(personaFacts(PERSONAS[k]).map(([label, value]) => [label, value]));
      expect(facts("hulldown")["Heat limit"]).toBe("4 Cold, 9 Hot within medium range");
      expect(facts("alpha")["Heat limit"]).toBe("13 Redline (shutdown roll at 14)");
      expect(facts("alpha")["Jump jets"]).toBe("never");
      expect(facts("gladiator")["Yields at"]).toBe("never");
      expect(facts("dispossessed")["Yields at"]).toBe("60% left, 75% while ahead, or no guns left");
      expect(facts("dispossessed").Ammo).toBe("Miser: TN ≤ 7, keeps 50%, energy first");
      expect(facts("longtom").Ammo).toBe("Conservative: TN ≤ 8, keeps 25%");
      expect(facts("pitfighter")["Yields at"]).toBe("20% left");
      expect(personaFacts(PERSONAS.alpha).every(([, , hint]) => hint !== "")).toBe(true);
      expect(weightMax("melee")).toBe(4);
      expect(weightMax("cover")).toBe(3);
      expect(weightMax("exposed")).toBe(1.5);
    });

    it("has a role line and a body for Player and every persona in both locales", () => {
      for (const k of ["player", ...PERSONA_KEYS]) {
        for (const cat of [en, ko] as Record<string, string>[]) {
          expect(cat[`persona.tag.${k}`]).toBeTruthy();
          expect(cat[`persona.body.${k}`]).toBeTruthy();
        }
      }
    });
  });

  it("Random battle sets no Player slot", () => {
    const l = randomLoadout(7, ["quickstart"]);
    expect(l.sides.flat().every((s) => s.persona !== null)).toBe(true);
    expect(l.mode).toEqual({ kind: "destroyAll" });
    expect(loadoutProblem(l)).toBeNull();
  });
});

describe("Instant Action import boundary", () => {
  // Boundary (docs/INSTANT.md "Architecture"): the app depends only on the engine and the TUI kit.
  it("never imports the terminal app", () => {
    const root = new URL("../web/instant/", import.meta.url).pathname;
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).not.toMatch(/from\s+"[^"]*terminal\//);
    }
  });
});

describe("Instant Action record sheet hints (TW pp. 42, 125, 159-160)", () => {
  it("lists heat sinks: engine-held, crit-slot devices white / gray / orange", () => {
    const u = battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null }).state.units
      .A1!; // HBK-4G: 13 single, CT 11 and two in each leg (sheet order)
    let tip = heatSinkTip(u);
    expect(tip.text).toBe(
      "Heat sinks: 13/13 single\nEngine: 8\nCrit slots: 5/5\nCT#11 RL#5 RL#6 LL#5 LL#6",
    );
    expect(tip.runs.map((r) => r[0]).join("")).toBe(tip.text);
    setSlotDestroyed(u.critSlotsDestroyed, "centerTorso", 10);
    u.damage.internalStructure.leftLeg = 0;
    tip = heatSinkTip(u);
    expect(tip.text.split("\n").slice(0, 3)).toEqual([
      "Heat sinks: 10/13 single",
      "Engine: 8",
      "Crit slots: 2/5",
    ]);
    const cls = Object.fromEntries(tip.runs.filter((r) => r[1]).map((r) => [r[0], r[1]]));
    expect(cls).toEqual({
      "CT#11": "ia-dim",
      "LL#5": "ia-lv-orange",
      "LL#6": "ia-lv-orange",
      "RL#5": "ia-lv-white",
      "RL#6": "ia-lv-white",
    });
    // the location tips colour their slots the same way (a stand-in kit pads the numbers)
    const g = globalThis as { window?: unknown };
    g.window = { TUI: { fit: (v: string, n: number) => String(v).padEnd(n) } };
    const slotCls = (loc: "centerTorso" | "leftLeg", n: number) =>
      critTip(u, loc).runs.filter((r) => r[0] !== "\n")[n]![1];
    expect(slotCls("centerTorso", 11)).toBe("ia-dim");
    expect(slotCls("centerTorso", 1)).toBe("ia-lv-white");
    expect(slotCls("leftLeg", 1)).toBe("ia-lv-orange");
    delete g.window;
  });

  const unit = (): UnitState => {
    const b = battle({ kind: "destroyAll" }, { A1: null, A2: null, B1: null, B2: null });
    const u = b.state.units.A1;
    if (!u) throw new Error("A1 missing");
    return u;
  };
  /** Destroy the first `n` slots of a component type. */
  const crit = (u: UnitState, type: string, n: number) => {
    const def = mechDefFor(u);
    let left = n;
    for (const [loc, slots] of Object.entries(def.critSlots)) {
      slots.forEach((slot, i) => {
        if (left > 0 && "type" in slot && slot.type === type) {
          setSlotDestroyed(u.critSlotsDestroyed, loc as "head", i);
          left--;
        }
      });
    }
    expect(left).toBe(0);
  };

  it("pilot: next consciousness roll by hits, the kill and the out states", () => {
    const u = unit();
    expect(pilotTip(u)).toContain(
      "Pilot unhurt (0/6 hits).\nNext hit: stay conscious on 2D6 3+ (97%).",
    );
    u.pilotHits = 3;
    expect(pilotTip(u)).toContain("Pilot 3/6 hits.\nNext hit: stay conscious on 2D6 10+ (17%).");
    u.pilotHits = 5;
    expect(pilotTip(u)).toContain("Next hit kills the pilot.");
    u.pilotHits = 3;
    u.unconsciousSinceTurn = 1;
    expect(pilotTip(u)).toContain("Wakes on 2D6 7+ (58%) in the End Phase.");
  });

  it("components: penalty now and the next hit, at every hit count", () => {
    const u = unit();
    expect(engineTip(u)).toBe("Engine intact (0/3 hits).\nHit 1: +5 heat per turn.");
    expect(gyroTip(u)).toContain("Hit 1: +3 to piloting rolls.");
    expect(sensorTip(u)).toContain("Hit 1: +2 to weapon attacks.");
    expect(lifeSupportTip(u)).toBe("Life support intact.\nOne hit knocks it out.");
    crit(u, "engine", 2);
    expect(engineTip(u)).toContain("Engine 2/3 hits: +10 heat per turn.\nNext hit destroys");
    crit(u, "gyro", 1);
    expect(gyroTip(u)).toContain("Running or jumping forces a piloting roll.");
    crit(u, "sensors", 2);
    expect(sensorTip(u)).toBe(
      "Sensors destroyed. No weapon fire.\nPhysical attacks are still allowed.",
    );
    crit(u, "lifeSupport", 1);
    expect(lifeSupportTip(u)).toContain("Heat 15-25 at end of Heat Phase: 1 pilot hit.");
  });

  it("heat: the scale value, its penalties and checks, and the next step", () => {
    const u = unit();
    u.heat = 12;
    u.heatPending = 9;
    const tip = heatTip(u);
    expect(tip).toContain("Heat 12 on the scale.");
    expect(tip).toContain("Now: -2 walking MP, +1 to-hit");
    expect(tip).not.toContain("This turn");
    u.heat = 18;
    expect(heatTip(u)).toContain(
      "Now: -3 walking MP, +3 to-hit\n  shutdown: avoid on 2D6 6+ (72%)",
    );
    u.shutdown = "heat";
    u.heat = 16;
    expect(heatTip(u)).toContain("Restart on 2D6 4+ (92%) in the Heat Phase; automatic below 14.");
    u.heat = 31;
    expect(heatTip(u)).toContain("No restart until heat drops below 30.");
  });
});

describe("glyph avatars (map/avatars)", () => {
  const models = ["data/mechs", "docs/mtf/sw/json"].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { model: string }).model),
  );

  it("gives every catalog model its own 10-glyph avatar", () => {
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect([...glyphOf(m)], m).toHaveLength(10);
      expect(glyphOf(m) === DEFAULT_GLYPH, m).toBe(false);
    }
  });

  it("falls back to the default avatar for an unknown model", () => {
    expect(glyphOf("NO-SUCH-MODEL")).toBe(DEFAULT_GLYPH);
    expect(DEFAULT_GLYPH).toBe(" ╭╮ ╽[]╽╽╽");
  });

  it("has no avatar for Choose 'Mech when the table does not list the model", () => {
    expect(avatarOf("NO-SUCH-MODEL")).toBeNull();
    expect(avatarOf("default")).toBeNull();
    expect(avatarOf(models[0]!)).toBe(glyphOf(models[0]!));
  });

  it("lists only models of the ci / fc / jh / sw / w39 packs", () => {
    const packs = new Set(
      ["ci", "fc", "jh", "sw", "w39"].flatMap((p) =>
        readdirSync(`docs/mtf/${p}/json`)
          .filter((f) => f.endsWith(".json"))
          .map(
            (f) =>
              (JSON.parse(readFileSync(join(`docs/mtf/${p}/json`, f), "utf8")) as { model: string })
                .model,
          ),
      ),
    );
    const stray = Object.keys(AVATARS).filter((m) => m !== "default" && !packs.has(m));
    expect(stray).toEqual([]);
  });
});

describe("Instant Action leave-page prompt", () => {
  const withUnit = emptyLoadout();
  withUnit.sides[0].push({} as (typeof withUnit.sides)[0][number]);
  it("asks only when leaving would throw away setup, deployment or a battle", () => {
    expect(leaveWarns({ screen: "loading", loadout: withUnit })).toBe(false);
    expect(leaveWarns({ screen: "title", loadout: withUnit })).toBe(false);
    expect(leaveWarns({ screen: "setup", loadout: emptyLoadout() })).toBe(false);
    expect(leaveWarns({ screen: "setup", loadout: withUnit })).toBe(true);
    for (const screen of ["deploy", "battle", "debrief"] as const)
      expect(leaveWarns({ screen, loadout: emptyLoadout() })).toBe(true);
  });
});

describe("Instant Action policy text (docs/INSTANT.md, Policies)", () => {
  it("codes the default policy AeJFMe and flips case for J and F", () => {
    expect(policyCodeOf(DEFAULT_UNIT_POLICY)).toBe("AeJFMe");
    expect(
      policyCodeOf({
        ...DEFAULT_UNIT_POLICY,
        ammoPolicy: "leastFirst",
        autoEject: false,
        heatFlamer: false,
        amsPolicy: "off",
      }),
    ).toBe("AljfMo");
  });

  it("names, describes and briefs every policy value in both locales", () => {
    for (const r of POLICY_ROWS) {
      for (const cat of [en, ko] as Record<string, string>[]) {
        expect(cat[`policy.${r.id}`]).toBeTruthy();
        for (const v of r.values) {
          const w = r.word(v);
          expect(cat[`policy.${r.id}.${w}`]).toBeTruthy();
          expect(cat[`policy.desc.${r.id}.${w}`]).toBeTruthy();
          expect(cat[`policy.brief.${r.id}.${w}`]).toBeTruthy();
        }
      }
    }
  });
});
