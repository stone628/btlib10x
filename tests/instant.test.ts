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
  ensureMapRegistered,
  type Facing,
  type HexCoord,
  type MapDef,
  mechDefFor,
  setSlotDestroyed,
  type UnitState,
} from "btlib10x";
import { describe, expect, it } from "vitest";
import type { PersonaKey } from "../web/instant/ai/persona.data";
import { BattleController } from "../web/instant/battle/controller";
import {
  autoPlace,
  edgeHexes,
  inwardFacing,
  oppositeEdge,
  rollOff,
  setupRng,
} from "../web/instant/battle/deploy";
import { unitLoss, type VictoryMode } from "../web/instant/battle/victory";
import { createRng } from "../web/instant/rng";
import {
  engineTip,
  gyroTip,
  heatTip,
  lifeSupportTip,
  pilotTip,
  sensorTip,
} from "../web/instant/screens/battle.hints";
import { pileTip } from "../web/instant/screens/piles";
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
