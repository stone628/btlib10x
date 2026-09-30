import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { shotsPerBinFor } from "../src/data/ammo.schema";
import { mechDef } from "../src/data/index";
import type { AmmoBin, AmmoBinState, AmmoBins } from "../src/rules/ammo";
import {
  ammoBinId,
  ammoWeaponTotals,
  collectAmmoBins,
  consumeAmmo,
  drawOrderBins,
  isAmmoPolicy,
  loadAmmoBins,
  parseAmmoPolicy,
  stripBinsInLocation,
} from "../src/rules/ammo";
import {
  advancePhase,
  type createBattle,
  declareAttacks,
  requireUnit,
  rollInitiativePhase,
  type UnitInit,
} from "../src/rules/game";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  requireWeaponAttackActor,
  type Session,
} from "../web/session";
import { createTestBattle, disableCritical, execute, scriptedRng } from "./helpers";

const HBK = mechDef("HBK-4G")!;
const HER = mechDef("HER-5SA")!;

/** One minimal live bin state, for hand-built maps in unit tests. */
function bin(location: Location, slotIndex: number, shots: number): AmmoBinState {
  return {
    id: ammoBinId(location, slotIndex),
    location,
    slotIndex,
    weaponIndex: 4,
    weapon: "AC/20",
    shots,
  };
}

describe("policy parsing", () => {
  it("recognizes every policy, case-insensitively, with optional hyphens", () => {
    expect(parseAmmoPolicy("exposed")).toBe("exposed");
    expect(parseAmmoPolicy("CORE")).toBe("core");
    expect(parseAmmoPolicy("Spread")).toBe("spread");
    expect(parseAmmoPolicy("least-first")).toBe("leastFirst");
    expect(parseAmmoPolicy("leastfirst")).toBe("leastFirst");
    expect(parseAmmoPolicy("bogus")).toBeNull();
  });

  it("isAmmoPolicy only accepts canonical spellings", () => {
    expect(isAmmoPolicy("exposed")).toBe(true);
    expect(isAmmoPolicy("Exposed")).toBe(false);
    expect(isAmmoPolicy("nope")).toBe(false);
  });
});

describe("bin loading", () => {
  it("spreads the declared shot count evenly over a weapon's bins", () => {
    // HBK-4G AC/20 (index 4): shots 10 across leftTorso slots 1-2.
    const bins = loadAmmoBins(HBK);
    expect(bins).toEqual({
      "leftTorso:1": { ...bin("leftTorso", 1, 5), weaponIndex: 4 },
      "leftTorso:2": { ...bin("leftTorso", 2, 5), weaponIndex: 4 },
    });
    expect(ammoWeaponTotals(HBK, bins)[4]).toBe(10);
  });

  it("pools shots-sharing mounts of one weapon name into every bin", () => {
    // MC-MKII-2: four Streak SRM 4 launchers share one 50-round pool spread
    // over the LT and RT ammo slots.
    const def = mechDef("MC-MKII-2")!;
    const bins = loadAmmoBins(def);
    expect(bins["rightTorso:7"]?.shots).toBe(25);
    expect(bins["leftTorso:7"]?.shots).toBe(25);
    const streakIdx = Number(
      Object.entries(def.weapons).find(
        ([, m]) => m.weapon === "CL Streak SRM 4" && m.shots !== undefined,
      )![0],
    );
    expect(ammoWeaponTotals(def, bins)[streakIdx]).toBe(50);
  });

  it("falls back to the ammo table capacity when no mount declares shots", () => {
    const def = mechDef("GRF-1N")!;
    const [lrmKey, lrmMount] = Object.entries(def.weapons).find(([, m]) => m.weapon === "LRM 10")!;
    const stripped = {
      ...def,
      weapons: {
        ...def.weapons,
        [lrmKey]: { weapon: lrmMount.weapon, location: lrmMount.location },
      },
    };
    const bins = loadAmmoBins(stripped);
    expect(bins["rightTorso:5"]?.shots).toBe(shotsPerBinFor({ weapon: "LRM 10" }));
    expect(bins["rightTorso:6"]?.shots).toBe(shotsPerBinFor({ weapon: "LRM 10" }));
  });

  it("collectAmmoBins enumerates in slot order", () => {
    expect(collectAmmoBins(HBK)).toEqual([
      {
        id: "leftTorso:1",
        location: "leftTorso",
        slotIndex: 1,
        weaponIndex: 4,
        weapon: "AC/20",
      },
      {
        id: "leftTorso:2",
        location: "leftTorso",
        slotIndex: 2,
        weaponIndex: 4,
        weapon: "AC/20",
      },
    ]);
  });
});

describe("bin utilities", () => {
  it("ammoBinId combines location and slot", () => {
    expect(ammoBinId("leftTorso", 3)).toBe("leftTorso:3");
  });

  it("stripBinsInLocation deletes only that location's bins", () => {
    const bins: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 5),
      "leftTorso:2": bin("leftTorso", 2, 5),
      "rightTorso:1": bin("rightTorso", 1, 6),
    };
    stripBinsInLocation(bins, "leftTorso");
    expect(bins).toEqual({ "rightTorso:1": bin("rightTorso", 1, 6) });
  });

  it("ammoWeaponTotals sums only the non-empty bins", () => {
    const bins: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 0),
      "leftTorso:2": bin("leftTorso", 2, 5),
    };
    expect(ammoWeaponTotals(HBK, bins)[4]).toBe(5);
  });
});

const ALL_LOCS = [
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
  "rightTorso",
  "leftTorso",
  "head",
  "centerTorso",
] as const;

function binsAt(locs: readonly Location[]): AmmoBin[] {
  return locs.map((location, i) => ({
    id: ammoBinId(location, i + 1),
    location,
    slotIndex: i + 1,
    weaponIndex: 1,
    weapon: "Test weapon",
  }));
}

describe("drawOrderBins", () => {
  it("exposed orders arms < legs < side torsos < head < center torso", () => {
    const order = drawOrderBins(
      binsAt([...ALL_LOCS]),
      {},
      "exposed",
      scriptedRng(2, 2, 2, 2, 2, 2, 2, 2),
    ).map((b) => b.location);
    expect(order).toEqual([...ALL_LOCS]);
  });

  it("core inverts: center torso < head < side torsos < legs < arms", () => {
    const order = drawOrderBins(
      binsAt([...ALL_LOCS]),
      {},
      "core",
      scriptedRng(2, 2, 2, 2, 2, 2, 2, 2),
    ).map((b) => b.location);
    expect(order).toEqual([
      "centerTorso",
      "head",
      "rightTorso",
      "leftTorso",
      "rightLeg",
      "leftLeg",
      "rightArm",
      "leftArm",
    ]);
  });

  it("spread favors the fullest bin; leastFirst the emptiest, without drawing rng", () => {
    const counts: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 3),
      "leftTorso:2": bin("leftTorso", 2, 1),
    };
    const base = binsAt(["leftTorso", "leftTorso"]);
    const rng = scriptedRng();
    expect(drawOrderBins(base, counts, "spread", rng)[0]!.id).toBe("leftTorso:1");
    expect(drawOrderBins(base, counts, "leastFirst", rng)[0]!.id).toBe("leftTorso:2");
    expect(rng.remaining()).toBe(0);
  });

  it("breaks equal-priority ties via the injected rng", () => {
    const base = binsAt(["leftTorso", "leftTorso"]);
    const counts: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 2),
      "leftTorso:2": bin("leftTorso", 2, 2),
    };
    // even d6 -> Fisher-Yates swap is a no-op, slot 1 leads; odd d6 -> slot 2.
    expect(drawOrderBins(base, counts, "exposed", scriptedRng(2))[0]!.id).toBe("leftTorso:1");
    expect(drawOrderBins(base, counts, "exposed", scriptedRng(1))[0]!.id).toBe("leftTorso:2");
  });
});

describe("consumeAmmo", () => {
  const start = (): AmmoBins => ({
    "leftTorso:1": bin("leftTorso", 1, 5),
    "leftTorso:2": bin("leftTorso", 2, 5),
  });

  it("draws each shot from the policy's next bin, ties decided by rng", () => {
    const even = consumeAmmo(HBK, start(), 4, 1, "exposed", scriptedRng(2));
    expect(even["leftTorso:1"]?.shots).toBe(4);
    expect(even["leftTorso:2"]?.shots).toBe(5);
    const odd = consumeAmmo(HBK, start(), 4, 1, "exposed", scriptedRng(1));
    expect(odd["leftTorso:1"]?.shots).toBe(5);
    expect(odd["leftTorso:2"]?.shots).toBe(4);
  });

  it("switches to another bin when the chosen one runs dry mid-burst", () => {
    const bins: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 1),
      "leftTorso:2": bin("leftTorso", 2, 5),
    };
    const after = consumeAmmo(HBK, bins, 4, 2, "exposed", scriptedRng(2, 2));
    expect(after["leftTorso:1"]?.shots).toBe(0);
    expect(after["leftTorso:2"]?.shots).toBe(4);
  });

  it("returns the input untouched when the weapon has no shots left", () => {
    const bins: AmmoBins = {
      "leftTorso:1": bin("leftTorso", 1, 0),
      "leftTorso:2": bin("leftTorso", 2, 0),
    };
    const rng = scriptedRng(2);
    const after = consumeAmmo(HBK, bins, 4, 1, "exposed", rng);
    expect(after).toEqual(bins);
    expect(rng.remaining()).toBe(1);
  });
});

function hbkBattle(): ReturnType<typeof createBattle> {
  const units: UnitInit[] = [
    {
      id: "hbk",
      model: "HBK-4G",
      team: 0,
      gunnery: 4,
      piloting: 5,
      position: { col: 2, row: 4 },
      facing: "ne",
    },
    {
      id: "enf",
      model: "ENF-4R",
      team: 1,
      gunnery: 4,
      piloting: 5,
      position: { col: 3, row: 4 },
      facing: "nw",
    },
  ];
  return createTestBattle([], units, true);
}

function attackPhase(state: ReturnType<typeof createBattle>): void {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, []);
}

describe("declareAttacks (game level)", () => {
  it("drains the declared weapon's bins and refreshes derived totals", () => {
    const state = hbkBattle();
    attackPhase(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], scriptedRng(2));
    const u = requireUnit(state, "hbk")!;
    expect(u.ammoBins["leftTorso:1"]?.shots).toBe(4);
    expect(u.ammoBins["leftTorso:2"]?.shots).toBe(5);
    expect(ammoWeaponTotals(HBK, u.ammoBins)[4]).toBe(9);
  });

  it("drains one shot per rapid-fire round declared (TW p.103-104)", () => {
    // HER-5SA Ultra AC/5 (weaponIndex 3, 1-based): 20 shots loaded; a double-tap declares 2.
    const units: UnitInit[] = [
      {
        id: "her",
        model: "HER-5SA",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ];
    const state = createTestBattle([], units, true);
    attackPhase(state);
    const before = ammoWeaponTotals(HER, requireUnit(state, "her")!.ammoBins)[3];
    expect(before).toBe(20);
    declareAttacks(
      state,
      "her",
      [{ weaponIndex: 3, targetId: "enf", rapidFire: true }],
      [],
      scriptedRng(6, 6, 6, 6, 6, 6),
    );
    const u = requireUnit(state, "her")!;
    expect(ammoWeaponTotals(HER, u.ammoBins)[3]).toBe(18);
  });

  it("uses a deterministic tiebreak rng when none is supplied", () => {
    const state = hbkBattle();
    attackPhase(state);
    // DEFAULT_RNG always rolls 1 -> the tie goes to slot 2.
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], []);
    const u = requireUnit(state, "hbk")!;
    expect(u.ammoBins["leftTorso:1"]?.shots).toBe(5);
    expect(u.ammoBins["leftTorso:2"]?.shots).toBe(4);
  });
});

function freshBrawl(): Session {
  const s = newSession(42);
  execute(s, "map quickstart");
  execute(s, "add hunchy HBK-4G 9 9 n");
  execute(s, "add cicada CDA-3MA 9 8 s");
  execute(s, "start");
  disableCritical(s);
  return s;
}

describe("ammo command (session)", () => {
  it("shows the acting unit's policy, sets it, and rejects gibberish", () => {
    const s = freshBrawl();
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
    expect(s.battle!.phase).toBe("weaponAttack");
    const actor = requireWeaponAttackActor(s).id;
    expect(execute(s, "ammo")[0]).toBe("ammo policy: exposed");
    expect(execute(s, "ammo spread")).toEqual([`${actor}: ammo policy set to spread`]);
    expect(s.battle!.units[actor]!.ammoPolicy).toBe("spread");
    expect(execute(s, "ammo least-first")[0]).toBe(`${actor}: ammo policy set to least-first`);
    expect(s.battle!.units[actor]!.ammoPolicy).toBe("leastFirst");
    expect(execute(s, "ammo nope")[0]).toMatch(/^error: ammo policy must be one of/);
    expect(s.battle!.units[actor]!.ammoPolicy).toBe("leastFirst");
  });

  it("renders the policy line on the record sheet only for ammo-carrying units", () => {
    const s = freshBrawl();
    s.battle!.units.hunchy!.ammoPolicy = "core";
    expect(execute(s, "sheet hunchy").join("\n")).toContain("ammo status: policy(core");
    expect(execute(s, "sheet cicada").join("\n")).not.toContain("ammo policy");
  });
});
