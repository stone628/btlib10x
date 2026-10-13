import { buildUnitInit, mechDefFor, type Rng, type UnitState } from "btlib10x";
import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types";
import { resolveWeaponAttack } from "../src/rules/attack";
import type { LocationValue, TorsoLocationValue, UnitDamageState } from "../src/rules/damage";
import { decodeUnitLine, encodeUnitLine } from "../web/terminal/replay";
import { createRng } from "../web/terminal/rng";
import { newSession, type Session, transferDetail } from "../web/terminal/session";
import { formatCritEffect } from "../web/terminal/session.attack";
import { disableCritical, execute, scriptedRng } from "./helpers";

function freshState(hp = 10): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = hp;
    is[loc] = hp;
  }
  return { armor, armorRear: {} as TorsoLocationValue, internalStructure: is };
}

const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

function strike(
  targetDamage: UnitDamageState,
  rng: ReturnType<typeof scriptedRng>,
  weaponName = "Small Laser",
  arc?: "front" | "rear",
) {
  return resolveWeaponAttack({
    ...BASE,
    rng,
    weapon: weaponName,
    targetDamage,
    ...(arc === undefined ? {} : { arc }),
  });
}

describe("transferDetail", () => {
  it("shows armor-only `before→after` for a non-penetrating hit", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armor.rightTorso).toBe(10);
    const text = transferDetail(res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTF 10->7\b/);
    expect(text).not.toMatch(/RTI/);
  });

  it("shows armor-then-structure at the same location for a penetrating hit", () => {
    const armor = {} as LocationValue;
    const is = {} as LocationValue;
    for (const loc of LOCATIONS) {
      armor[loc] = loc === "rightTorso" ? 2 : 10;
      is[loc] = 10;
    }
    const s: UnitDamageState = {
      armor,
      armorRear: {} as TorsoLocationValue,
      internalStructure: is,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    const text = transferDetail(res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTF 2->0\*?/);
    expect(text).toMatch(/RTI 10->9\b/);
  });

  it("uses `app.before` as the snapshot, not a reconstruction from `after`", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT
    const res = strike(s, rng);
    expect(res.application?.before).toBeDefined();
    if (res.application) {
      const beforeRear = res.application.before.armorRear;
      const beforeArmor = res.application.before.armor;
      expect(beforeRear).toEqual({});
      expect(beforeArmor.rightTorso).toBe(10);
    }
  });

  it("never emits NaN for a step at a fresh location", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3);
    const res = strike(s, rng);
    const text = transferDetail(res) ?? "";
    expect(text).not.toMatch(/NaN/);
  });

  it("labels torso armor as front-armor F when a rear pool is present", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 } as TorsoLocationValue,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/RTF 10->7\b/);
    expect(text).not.toMatch(/RTA/);
  });

  it("labels non-torso armor as plain armor A (no rear pool)", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 4, 5); // to-hit 12, location 9 -> leftLeg, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armor.leftLeg).toBe(10);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/LLA 10->7\b/);
    expect(text).not.toMatch(/LLF/);
  });

  it("labels rear-arc torso hits on the rear pool as R", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 } as TorsoLocationValue,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, rear arc
    const res = strike(s, rng, "Small Laser", "rear");
    expect(res.application?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/RTR 5->2\b/);
    expect(text).not.toMatch(/RT[AFI]/);
  });
});

describe("formatCritEffect limb blow-off", () => {
  it("fills the placeholder for leg and arm blow-offs", () => {
    const leg = formatCritEffect({ kind: "limbBlownOff", limb: "leftLeg", rolls: [12] });
    const arm = formatCritEffect({ kind: "limbBlownOff", limb: "leftArm", rolls: [12] });
    expect(leg).not.toMatch(/[{}]/);
    expect(arm).not.toMatch(/[{}]/);
  });
});

describe("blastDetail destruction tail (TW p. 128)", () => {
  it("reports the 'Mech destroyed, never the pilot killed", () => {
    const s = freshState();
    s.armor.centerTorso = 0;
    s.internalStructure.centerTorso = 1;
    const res = strike(s, scriptedRng(6, 6, 3, 4)); // to-hit 12, location 7 -> CT
    expect(res.application?.mechDestroyed).toBe(true);
    const text = transferDetail(res);
    expect(text).toMatch(/CTI 1->0\*.*; 'Mech destroyed$/);
    expect(text).not.toMatch(/killed/);
  });
});

/** Fixed dice first, then a seeded stream for whatever follows (PSRs, initiative). */
function diceThen(fixed: readonly number[], seed = 1): Rng {
  const rest = createRng(seed);
  let i = 0;
  return {
    d6: () => (i < fixed.length ? fixed[i++]! : rest.d6()),
    snapshot: () => rest.snapshot(),
    load: (v: string) => rest.load(v),
  };
}

/** HBK (me) fires its medium laser at an adjacent WVR (foe) with the given hit location dice. */
function shootFoe(
  prepare: (foe: UnitState) => void,
  locationDice: [number, number],
  crits: readonly number[] = [],
): string[] {
  return shootFoeSession(prepare, locationDice, crits).out;
}

function shootFoeSession(
  prepare: (foe: UnitState) => void,
  locationDice: [number, number],
  crits: readonly number[] = [],
): { out: string[]; s: Session } {
  const s = newSession(3);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 8 s");
  execute(s, "start");
  if (crits.length === 0) disableCritical(s);
  prepare(s.battle!.units.foe!);
  for (let i = 0; i < 4 && s.battle!.phase === "movement"; i++) {
    execute(s, "mode standstill");
    execute(s, "done");
  }
  // Let the foe pass its attack first if it acts first.
  if (s.attack?.actorId === "foe") execute(s, "done");
  expect(s.attack?.actorId).toBe("me");
  const laser = Object.entries(mechDefFor(s.battle!.units.me!).weapons).find(
    ([, w]) => w.weapon === "Medium Laser" && w.location !== "rightArm",
  )![0];
  s.rng = diceThen([6, 6, ...locationDice, ...crits]);
  execute(s, `fire foe ${laser}`);
  const out = execute(s, "done");
  if (s.attack?.actorId === "foe") out.push(...execute(s, "done"));
  return { out, s };
}

describe("web log: 'Mech destroyed vs. the pilot's fate", () => {
  it("plain CT kill: 'Mech destroyed, then DESTROYED (pilot stays inside)", () => {
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.centerTorso = 0;
        foe.damage.internalStructure.centerTorso = 1;
      },
      [3, 4],
    ).join("\n");
    expect(out).toMatch(/CTI 1->0\*.*; 'Mech destroyed/);
    expect(out).toMatch(/\[foe\] \*\*\* DESTROYED/);
    expect(out).not.toMatch(/killed/i);
  });

  it("head kill: 'Mech destroyed, then the ejection PSR and the pilot ejects", () => {
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 1;
      },
      [6, 6],
    ).join("\n");
    const destroyed = out.indexOf("'Mech destroyed");
    const psr = out.indexOf("ejecting");
    // Consecutive [foe] lines share one box, so the eject line has no prefix.
    const ejects = out.indexOf("ejects — abandoned");
    expect(destroyed).toBeGreaterThan(-1);
    expect(psr).toBeGreaterThan(destroyed);
    expect(ejects).toBeGreaterThan(psr);
    expect(out).not.toMatch(/; killed/);
  });

  it("head blown off by a critical: the pilot still tries to eject", () => {
    // Extra head structure keeps the laser from destroying the head by damage,
    // so the 12 on the determining roll is what removes it.
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 9;
      },
      [6, 6],
      [6, 6],
    ).join("\n");
    expect(out).toMatch(/PSR ejecting/);
    expect(out).toMatch(/ejects — abandoned/);
  });

  it("auto-eject off: a head kill destroys the 'Mech and kills the pilot", () => {
    const { out, s } = shootFoeSession(
      (foe) => {
        foe.autoEject = false;
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 1;
      },
      [6, 6],
    );
    const text = out.join("\n");
    expect(text).toMatch(/'Mech destroyed/);
    expect(text).not.toMatch(/PSR ejecting/);
    expect(text).toMatch(/\*\*\* DESTROYED \(HD destroyed\) \*\*\*/);
    const foe = s.battle!.units.foe!;
    expect(foe.pilotHits).toBe(foe.pilotHitMax);
  });
});

describe("set <id> autoEject", () => {
  it("toggles the policy in setup, shows it in status, and rejects other values", () => {
    const s = newSession(1);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    expect(s.setup.roster[0]!.policy.autoEject).toBe(true);
    expect(execute(s, "set me autoEject off")).toEqual(["me: autoEject set to off"]);
    expect(s.setup.roster[0]!.policy).toEqual({ ammoPolicy: "exposed", autoEject: false });
    expect(execute(s, "status").join("\n")).toMatch(/auto-eject off/);
    expect(execute(s, "set me autoEject maybe")[0]).toMatch(/autoEject must be on or off/);
    execute(s, "set me ammoPolicy core");
    expect(s.setup.roster[0]!.policy).toEqual({ ammoPolicy: "core", autoEject: false });
  });

  it("round-trips through replay unit records", () => {
    const base = buildUnitInit("me", "HBK-4G", 1, { col: 9, row: 9 }, "n");
    const off = { ...base, policy: { ammoPolicy: "exposed" as const, autoEject: false } };
    const line = encodeUnitLine(off);
    expect(line.endsWith(":ex")).toBe(true);
    expect(decodeUnitLine(line).policy).toEqual({ ammoPolicy: "exposed", autoEject: false });
    expect(encodeUnitLine(base)).not.toMatch(/:e?x?$/);
    expect(decodeUnitLine(encodeUnitLine(base)).policy.autoEject).toBe(true);
  });
});
