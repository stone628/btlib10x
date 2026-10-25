import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMtf } from "../scripts/mtf.mjs";
import { LOCATIONS } from "../src/core/types";
import { type MechDef, resolveMechDef, validateMechDef } from "../src/data/index";
import { parseWeaponsData, weaponDef } from "../src/data/weapon.schema";
import { resolveWeaponAttack } from "../src/rules/attack";
import type { LocationValue, TorsoLocationValue, UnitDamageState } from "../src/rules/damage";
import { DEFAULT_UNIT_POLICY } from "../src/rules/game/constants";
import { buildUnitInit } from "../src/rules/game/create";
import { declareAttacks } from "../src/rules/game/declare";
import { advancePhase } from "../src/rules/game/loop";
import { executeMove, passMovement } from "../src/rules/game/move";
import { attemptVoluntaryStartup, voluntaryShutdown } from "../src/rules/game/pilotActions";
import { requireUnit } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { nextActor, rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { BattleState, GameEvent, UnitInit, UnitPolicy } from "../src/rules/game/types";
import { OUTSIDE_HEAT_CAP, outsideHeatApplied } from "../src/rules/heat";
import { parseBattleState, saveBattleState } from "../src/rules/snapshot";
import { decodeUnitLine, encodeUnitLine } from "../web/terminal/replay";
import { commitMovement, declareMovementMode, newSession } from "../web/terminal/session";
import { createTestBattle } from "./helpers/battle";
import { scriptedRng } from "./helpers/rng";
import { execute } from "./helpers/session";

function freshDamage(hp = 10): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = hp;
    is[loc] = hp;
  }
  return { armor, armorRear: {} as TorsoLocationValue, internalStructure: is };
}

/** Stationary gunnery-4 shooter at range 1 vs stationary target in the clear: TN 4. */
const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

/** HER-5SA (Flamer = weapon 2, left arm) adjacent to an ENF-4R. */
function herVsEnf(policy: UnitPolicy = DEFAULT_UNIT_POLICY): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("her", "HER-5SA", 1, { col: 2, row: 4 }, "ne", 4, 5, 6, policy),
    buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
  ];
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, [], scriptedRng());
  return state;
}

const FLAMER = 2;

function fireFlamer(state: BattleState, rolls: number[]): GameEvent[] {
  declareAttacks(
    state,
    "her",
    [{ weaponIndex: FLAMER, targetId: "enf" }],
    [],
    [],
    scriptedRng(1, 1, 1, 1),
  );
  const events: GameEvent[] = [];
  resolveAllAttacks(state, scriptedRng(...rolls), events);
  return events;
}

function eventsOf<K extends GameEvent["kind"]>(
  events: readonly GameEvent[],
  kind: K,
): Extract<GameEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<GameEvent, { kind: K }> => e.kind === kind);
}

describe("heat-causing weapon catalog (TW pp.139, 303-304)", () => {
  it("flags the flamer family asHeat and plasma weapons extraHeat", () => {
    for (const name of [
      "Flamer",
      "CL Flamer",
      "ER Flamer",
      "CL ER Flamer",
      "Heavy Flamer",
      "CL Heavy Flamer",
    ]) {
      expect(weaponDef(name)?.heatEffect, name).toEqual({ kind: "asHeat" });
    }
    expect(weaponDef("Plasma Rifle")?.heatEffect).toEqual({ kind: "extraHeat", dice: 1 });
    expect(weaponDef("CL Plasma Cannon")).toMatchObject({
      damage: 0,
      heat: 7,
      short: 6,
      medium: 12,
      long: 18,
      heatEffect: { kind: "extraHeat", dice: 2 },
    });
  });

  it("validates heatEffect shapes", () => {
    const bad =
      (heatEffect: unknown, damage = 2) =>
      () =>
        parseWeaponsData([
          { name: "X", short: 1, medium: 2, long: 3, damage, category: "ENERGY", heatEffect },
        ]);
    expect(bad({ kind: "asHeat" }, 0)).toThrow(/asHeat needs a positive damage/);
    expect(bad({ kind: "extraHeat", dice: 3 })).toThrow(/dice must be 1 or 2/);
    expect(bad({ kind: "burn" })).toThrow(/kind must be asHeat or extraHeat/);
  });
});

describe("resolveWeaponAttack heat effects", () => {
  it("heat mode: a flamer hit deals its Damage Value as heat, no location roll or damage", () => {
    const rng = scriptedRng(3, 3); // to-hit 6 >= 4; nothing else rolled
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Flamer",
      heatMode: true,
      targetDamage: freshDamage(),
    });
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([]);
    expect(res.applications).toEqual([]);
    expect(res.crits).toEqual([]);
    expect(res.inflictedHeat).toEqual({ heat: 2, source: "asHeat" });
    expect(res.targetDamageAfter).toEqual(freshDamage());
    expect(rng.remaining()).toBe(0);
  });

  it("heat mode off: the flamer deals normal damage", () => {
    const rng = scriptedRng(3, 3, 3, 4); // hit; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Heavy Flamer",
      heatMode: false,
      targetDamage: freshDamage(),
    });
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 4, throughArmor: false }]);
    expect(res.inflictedHeat).toBeUndefined();
  });

  it("a heat-mode miss inflicts nothing", () => {
    const res = resolveWeaponAttack({
      ...BASE,
      rng: scriptedRng(1, 2),
      weapon: "Flamer",
      heatMode: true,
      targetDamage: freshDamage(),
    });
    expect(res.hit).toBe(false);
    expect(res.inflictedHeat).toBeUndefined();
  });

  it("heatMode is ignored on weapons that are not asHeat", () => {
    const rng = scriptedRng(3, 3, 3, 4);
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Small Laser",
      heatMode: true,
      targetDamage: freshDamage(),
    });
    expect(res.groups).toHaveLength(1);
    expect(res.inflictedHeat).toBeUndefined();
  });

  it("Plasma Rifle: 10 damage, then 1D6 heat thrown after the damage resolves", () => {
    const rng = scriptedRng(3, 3, 3, 4, 5); // hit; CT; heat die 5
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Plasma Rifle",
      targetDamage: freshDamage(),
    });
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 10, throughArmor: false }]);
    expect(res.inflictedHeat).toEqual({ heat: 5, source: "extraHeat", dice: [5] });
    expect(rng.remaining()).toBe(0);
  });

  it("Plasma Cannon: 2D6 heat and no damage, location or crit", () => {
    const rng = scriptedRng(3, 3, 4, 6); // hit; heat dice 4 + 6
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "CL Plasma Cannon",
      targetDamage: freshDamage(),
    });
    expect(res.groups).toEqual([]);
    expect(res.applications).toEqual([]);
    expect(res.inflictedHeat).toEqual({ heat: 10, source: "extraHeat", dice: [4, 6] });
    expect(rng.remaining()).toBe(0);
  });
});

describe("outside heat in the battle (TW p.159)", () => {
  it("caps outside heat at 15 per turn", () => {
    expect(OUTSIDE_HEAT_CAP).toBe(15);
    expect(outsideHeatApplied(0)).toBe(0);
    expect(outsideHeatApplied(9)).toBe(9);
    expect(outsideHeatApplied(16)).toBe(15);
  });

  it("a heat-mode flamer hit tallies outside heat, landing only in the heat phase", () => {
    const state = herVsEnf();
    const enf = requireUnit(state, "enf");
    const events = fireFlamer(state, [6, 6]);
    expect(enf.heatExternalPending).toBe(2);
    expect(enf.heat).toBe(0);
    const [inflicted] = eventsOf(events, "heatInflicted");
    expect(inflicted).toEqual({
      kind: "heatInflicted",
      unitId: "her",
      targetId: "enf",
      weapon: "Flamer",
      heat: 2,
      source: "asHeat",
      totalReceived: 2,
    });
    // The attacker still pays the flamer's own 3 heat.
    expect(requireUnit(state, "her").heatPending).toBe(3);
  });

  it("deals damage instead when the attacker's heatFlamer policy is off", () => {
    const state = herVsEnf({ ...DEFAULT_UNIT_POLICY, heatFlamer: false });
    const enf = requireUnit(state, "enf");
    const armorBefore = { ...enf.damage.armor };
    const events = fireFlamer(state, [6, 6, 3, 4]); // hit; location 7 -> CT
    expect(enf.heatExternalPending).toBe(0);
    expect(eventsOf(events, "heatInflicted")).toEqual([]);
    expect(enf.damage.armor.centerTorso).toBe(armorBefore.centerTorso - 2);
  });

  it("applies received heat in the heat phase, wasting anything over 15", () => {
    const state = herVsEnf();
    const enf = requireUnit(state, "enf");
    enf.heatExternalPending = 18;
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(6, 6, 6, 6, 6, 6, 6, 6));
    expect(eventsOf(events, "heatExternal").find((e) => e.unitId === "enf")).toEqual({
      kind: "heatExternal",
      unitId: "enf",
      received: 18,
      applied: 15,
      wasted: 3,
    });
    const dissip = eventsOf(events, "heatDissipated").find((e) => e.unitId === "enf")!;
    expect(dissip.external).toBe(15);
    expect(dissip.endHeat).toBe(15 - dissip.dissip);
    expect(enf.heatExternalPending).toBe(0);
  });

  it("round-trips the policy and pending outside heat through snapshots", () => {
    const state = herVsEnf({ ...DEFAULT_UNIT_POLICY, heatFlamer: false });
    requireUnit(state, "enf").heatExternalPending = 4;
    const parsed = parseBattleState(saveBattleState(state));
    expect(parsed.units.her!.heatFlamer).toBe(false);
    expect(parsed.units.enf!.heatExternalPending).toBe(4);
  });
});

describe("heatFlamer setup and replay", () => {
  it("toggles through `set <id> heatFlamer` and shows only when off", () => {
    const s = newSession(1);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    expect(s.setup.roster[0]!.policy.heatFlamer).toBe(true);
    expect(execute(s, "status").join("\n")).not.toMatch(/flamer-heat/);
    expect(execute(s, "set me heatFlamer off")).toEqual(["me: heatFlamer set to off"]);
    expect(s.setup.roster[0]!.policy.heatFlamer).toBe(false);
    expect(execute(s, "status").join("\n")).toMatch(/flamer-heat off/);
    expect(execute(s, "set me heatFlamer maybe")[0]).toMatch(/heatFlamer must be on or off/);
  });

  it("encodes heatFlamer off as an `f` policy suffix and omits the default", () => {
    const base = buildUnitInit("me", "HBK-4G", 1, { col: 9, row: 9 }, "n");
    expect(decodeUnitLine(encodeUnitLine(base)).policy.heatFlamer).toBe(true);
    const off = { ...base, policy: { ...base.policy, heatFlamer: false } };
    expect(encodeUnitLine(off).endsWith(":f")).toBe(true);
    expect(decodeUnitLine(encodeUnitLine(off)).policy).toEqual({
      ammoPolicy: "exposed",
      autoEject: true,
      heatFlamer: false,
      amsPolicy: "expected",
    });
    const both = {
      ...base,
      policy: {
        ammoPolicy: "core" as const,
        autoEject: false,
        heatFlamer: false,
        amsPolicy: "expected" as const,
      },
    };
    expect(encodeUnitLine(both).endsWith(":cxf")).toBe(true);
    expect(decodeUnitLine(encodeUnitLine(both)).policy).toEqual(both.policy);
  });
});

describe("heat-mode flamer in the terminal", () => {
  it("logs the heat hit, the outside heat tally and the heat phase", () => {
    const s = newSession(42);
    execute(s, "map quickstart");
    execute(s, "add her HER-5SA 9 9 n");
    execute(s, "add enf ENF-4R 9 8 s");
    execute(s, "start");
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
    const log: string[] = [];
    let fired = false;
    while (s.state === "battle" && s.battle!.phase === "attack") {
      if (s.attack!.actorId === "her" && !fired) {
        log.push(...execute(s, "fire enf 2"));
        fired = true;
      }
      log.push(...execute(s, "done"));
    }
    const text = log.join("\n");
    expect(fired).toBe(true);
    if (/Flamer.*(hit|auto)/i.test(text)) {
      expect(text).toMatch(/2 heat to target instead of damage/);
      expect(text).toMatch(/\[enf\] takes 2 outside heat/);
      expect(text).toMatch(/absorbs 2 outside heat/);
      expect(text).toMatch(/\+ outside\(2\)/);
    } else {
      expect(text).not.toMatch(/outside heat/);
    }
  });
});

describe("MTF sheets that needed thermal weapons", () => {
  const convert = (file: string) => {
    const { def, errors } = parseMtf(readFileSync(file, "utf8"), file);
    expect(errors).toEqual([]);
    return resolveMechDef(validateMechDef(def as unknown as MechDef));
  };
  const names = (file: string) => Object.values(convert(file).weapons).map((w) => w.weapon);

  it("maps Clan flamers, ER/Heavy Flamers and the Plasma Cannon", () => {
    expect(names("docs/mtf/ci/mtf/Puma (Adder) Prime.mtf")).toContain("CL Flamer");
    expect(names("docs/mtf/jh/mtf/Arctic Wolf J.mtf")).toContain("CL Plasma Cannon");
    expect(names("docs/mtf/jh/mtf/Pouncer F.mtf")).toEqual(
      expect.arrayContaining(["CL Plasma Cannon", "CL ER Flamer", "CL Heavy Flamer"]),
    );
    expect(names("docs/mtf/jh/mtf/Icestorm 2.mtf")).toContain("CL ER Flamer");
  });
});

describe("voluntary", () => {
  function hbkVsEnf(): BattleState {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
    ];
    return createTestBattle([], units, true);
  }

  function startMovementTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
    rollInitiativePhase(state, rng, []);
    return state;
  }

  describe("voluntary shutdown", () => {
    it("requires the movement phase", () => {
      const state = hbkVsEnf();
      expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/before initiative/);
    });

    it("takes an online unit off-line and marks it as acted", () => {
      const state = startMovementTurn(hbkVsEnf());
      const events: GameEvent[] = [];
      voluntaryShutdown(state, "hbk", events);
      expect(requireUnit(state, "hbk").shutdown).toBe("manual");
      expect(state.actedThisPhase).toContain("hbk");
      expect(
        events.some(
          (e) =>
            e.kind === "shutdownCheck" && e.unitId === "hbk" && e.manual && e.result !== "avoid",
        ),
      ).toBe(true);
    });

    it("rejects a unit that is already shut down", () => {
      const state = startMovementTurn(hbkVsEnf());
      requireUnit(state, "hbk").shutdown = "manual";
      expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/already shut down/);
    });

    it("blocks movement and firing while down", () => {
      const state = startMovementTurn(hbkVsEnf());
      voluntaryShutdown(state, "hbk", []);
      // hbk is down; only enf remains in the movement phase. Move enf, then
      // advance to weapon attack. hbk (still down) must be refused a
      // target declaration.
      executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() });
      expect(requireUnit(state, "hbk").shutdown).toBe("manual");
      advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
      expect(() =>
        declareAttacks(
          state,
          "hbk",
          [{ weaponIndex: 1, targetId: "enf" }],
          [],
          [],
          scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
        ),
      ).toThrow(/shut down|current actor/);
    });

    it("persists through the heat phase instead of auto-restarting", () => {
      const state = hbkVsEnf();
      const hbk = requireUnit(state, "hbk");
      hbk.shutdown = "manual";
      hbk.heat = 12;
      startMovementTurn(state);
      advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
      advancePhase(state, [], scriptedRng(3, 3, 3, 1)); // weaponAttack -> end (heat check)
      expect(hbk.shutdown).toBe("manual");
    });
  });

  describe("voluntary startup", () => {
    it("auto-succeeds below the shutdown threshold (heat < 14)", () => {
      const state = startMovementTurn(hbkVsEnf());
      const hbk = requireUnit(state, "hbk");
      hbk.shutdown = "manual"; // shut down in an earlier turn
      const events: GameEvent[] = [];
      attemptVoluntaryStartup(state, "hbk", events, scriptedRng());
      expect(hbk.shutdown).toBe("not");
      expect(
        events.some(
          (e) =>
            e.kind === "restartCheck" && e.unitId === "hbk" && e.result === "success" && e.manual,
        ),
      ).toBe(true);
      expect(state.actedThisPhase).toContain("hbk");
    });

    it("fails when the avoidance roll is too low", () => {
      const state = startMovementTurn(hbkVsEnf());
      const hbk = requireUnit(state, "hbk");
      hbk.heat = 18; // avoid 6
      hbk.shutdown = "manual"; // shut down in an earlier turn
      const events: GameEvent[] = [];
      attemptVoluntaryStartup(state, "hbk", events, scriptedRng(2, 1)); // 2D6 = 3 < 6
      expect(hbk.shutdown).toBe("manual");
      expect(
        events.some(
          (e) =>
            e.kind === "restartCheck" && e.unitId === "hbk" && e.result !== "success" && e.manual,
        ),
      ).toBe(true);
      expect(state.actedThisPhase).toContain("hbk");
    });

    it("cannot start up at heat 30+, even with a perfect roll, and rolls nothing", () => {
      const state = startMovementTurn(hbkVsEnf());
      const hbk = requireUnit(state, "hbk");
      hbk.heat = 30;
      hbk.shutdown = "manual"; // shut down in an earlier turn
      const events: GameEvent[] = [];
      attemptVoluntaryStartup(state, "hbk", events, scriptedRng(6, 6));
      expect(hbk.shutdown).toBe("manual");
      expect(events).toMatchObject([
        { kind: "restartCheck", result: "heat", manual: true, roll: 0 },
      ]);
      expect(state.actedThisPhase).toContain("hbk");
    });

    it("gives an unconscious pilot no startup attempt: the unit is not an actor (TW p.42)", () => {
      const state = startMovementTurn(hbkVsEnf());
      const hbk = requireUnit(state, "hbk");
      hbk.unconsciousSinceTurn = state.turn;
      hbk.shutdown = "manual"; // shut down in an earlier turn
      expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
        /not the current actor/,
      );
      expect(hbk.shutdown).toBe("manual");
      expect(nextActor(state)).toBe("enf");
    });

    it("rejects an online unit, including one that just started up", () => {
      const state = startMovementTurn(hbkVsEnf());
      expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
        /not shut down/,
      );
      requireUnit(state, "hbk").shutdown = "manual";
      attemptVoluntaryStartup(state, "hbk", [], scriptedRng());
      // the startup was its declaration: a second one is out of turn
      expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
        /not the current actor/,
      );
    });

    it("comes online at once: movement is spent, the attack phase is kept", () => {
      const state = startMovementTurn(hbkVsEnf());
      const hbk = requireUnit(state, "hbk");
      hbk.shutdown = "manual"; // shut down in an earlier turn
      attemptVoluntaryStartup(state, "hbk", [], scriptedRng());
      expect(hbk.shutdown).toBe("not");
      expect(state.actedThisPhase).toContain("hbk");
      expect(hbk.mpSpent).toBe(0);
      advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
      const first = nextActor(state) as string;
      state.actedThisPhase.push(first);
      expect(new Set([first, nextActor(state)])).toEqual(new Set(["hbk", "enf"]));
    });
  });

  describe("movement pass for shut-down units", () => {
    it("marks a down unit as acted without changing state", () => {
      const state = startMovementTurn(hbkVsEnf());
      requireUnit(state, "hbk").shutdown = "manual"; // shut down in an earlier turn
      passMovement(state, "hbk");
      expect(requireUnit(state, "hbk").shutdown).toBe("manual");
      expect(state.actedThisPhase).toContain("hbk");
      expect(nextActor(state)).toBe("enf");
    });

    it("rejects an online unit", () => {
      const state = startMovementTurn(hbkVsEnf());
      expect(() => passMovement(state, "hbk")).toThrow(/not shut down/);
    });
  });

  describe("movement priority for shut-down units", () => {
    it("puts a down unit first regardless of initiative", () => {
      const state = hbkVsEnf();
      startMovementTurn(state, scriptedRng(2, 2, 6, 6)); // team 2 (enf) wins initiative
      requireUnit(state, "hbk").shutdown = "heat"; // down, not acted this turn
      expect(nextActor(state)).toBe("hbk");
    });

    it("skips down units in the weapon attack phase", () => {
      const state = startMovementTurn(hbkVsEnf());
      voluntaryShutdown(state, "hbk", []);
      executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() });
      advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
      expect(nextActor(state)).toBe("enf");
    });
  });
});
