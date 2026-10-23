import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { allAmmo, ammoDefFor, shotsPerBinFor } from "../src/data/ammo.schema";
import { mechDef } from "../src/data/index";
import { weaponDefFor } from "../src/data/weapon.schema";
import {
  type AmmoBin,
  type AmmoBins,
  ammoBinId,
  ammoWeaponTotals,
  binsForWeapon,
  binsForWeaponName,
  collectAmmoBins,
  consumeAmmo,
  drawOrderBins,
  loadAmmoBins,
  pooledShotsLeft,
  strandedShots,
  usableShots,
} from "../src/rules/ammo";
import { setSlotDestroyed } from "../src/rules/critical";
import { suggestFireTargets } from "../src/rules/fireability";
import {
  advancePhase,
  buildUnitInit,
  type createBattle,
  declareAttacks,
  requireUnit,
  rollInitiativePhase,
  type UnitInit,
} from "../src/rules/game";
import { newSession, type Session } from "../web/terminal/session";
import { createTestBattle, critState, disableCritical, execute, scriptedRng } from "./helpers";

describe("ammo catalog", () => {
  it("every ammo weapon resolves as a catalog weapon", () => {
    for (const ammo of allAmmo()) {
      expect(weaponDefFor({ weapon: ammo.weapon }).name).toBe(ammo.weapon);
    }
  });

  it("getShotsPerBinFor returns undefined for non-ammo weapons", () => {
    expect(shotsPerBinFor({ weapon: "Medium Laser" })).toBeUndefined();
    expect(shotsPerBinFor({ weapon: "Flamer" })).toBeUndefined();
    expect(shotsPerBinFor({ weapon: "Not A Weapon" })).toBeUndefined();
  });

  it("getAmmoDefFor throws on an unknown weapon", () => {
    expect(() => ammoDefFor({ weapon: "Not A Weapon" })).toThrow();
  });
});

describe("depletion", () => {
  const HBK = mechDef("HBK-4G")!;
  const HER = mechDef("HER-5SA")!;

  describe("bin loading", () => {
    it("spreads the declared shot count evenly over a weapon's bins", () => {
      // HBK-4G AC/20 (index 4): shots 10 across leftTorso slots 1-2.
      const bins = loadAmmoBins(HBK);
      expect(bins).toEqual({
        "leftTorso:1": 5,
        "leftTorso:2": 5,
      });
      expect(ammoWeaponTotals(HBK, critState(HBK, bins))[4]).toBe(10);
    });

    it("pools shots-sharing mounts of one weapon name into every bin", () => {
      // MC-MKII-2: four Streak SRM 4 launchers share one 50-round pool spread
      // over the LT and RT ammo slots.
      const def = mechDef("MC-MKII-2")!;
      const bins = loadAmmoBins(def);
      expect(bins["rightTorso:7"]).toBe(25);
      expect(bins["leftTorso:7"]).toBe(25);
      const streakIdx = Number(
        Object.entries(def.weapons).find(
          ([, m]) => m.weapon === "CL Streak SRM 4" && m.shots !== undefined,
        )![0],
      );
      expect(ammoWeaponTotals(def, critState(def, bins))[streakIdx]).toBe(50);
    });

    it("falls back to the ammo table capacity when no mount declares shots", () => {
      const def = mechDef("GRF-1N")!;
      const [lrmKey, lrmMount] = Object.entries(def.weapons).find(
        ([, m]) => m.weapon === "LRM 10",
      )!;
      const stripped = {
        ...def,
        weapons: {
          ...def.weapons,
          [lrmKey]: { weapon: lrmMount.weapon, location: lrmMount.location },
        },
      };
      const bins = loadAmmoBins(stripped);
      expect(bins["rightTorso:5"]).toBe(shotsPerBinFor({ weapon: "LRM 10" }));
      expect(bins["rightTorso:6"]).toBe(shotsPerBinFor({ weapon: "LRM 10" }));
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

    it("a bin in a location lost to plain damage is stranded: unusable, shots kept", () => {
      const state = critState(HBK, { "leftTorso:1": 5, "leftTorso:2": 0 });
      state.damage.internalStructure.leftTorso = 0;
      const [bin1] = collectAmmoBins(HBK);
      expect(state.ammoBins["leftTorso:1"]).toBe(5); // the count is untouched
      expect(usableShots(state, bin1!)).toBe(0);
      expect(strandedShots(state, bin1!)).toBe(5);
      expect(ammoWeaponTotals(HBK, state)[4] ?? 0).toBe(0);
    });

    it("a bin whose slot is flagged is destroyed: no shots, no salvage", () => {
      const state = critState(HBK, { "leftTorso:1": 5, "leftTorso:2": 5 });
      setSlotDestroyed(state.critSlotsDestroyed, "leftTorso", 0);
      const [bin1, bin2] = collectAmmoBins(HBK);
      expect(usableShots(state, bin1!)).toBe(0);
      expect(strandedShots(state, bin1!)).toBe(0);
      expect(usableShots(state, bin2!)).toBe(5);
      expect(ammoWeaponTotals(HBK, state)[4]).toBe(5);
    });

    it("ammoWeaponTotals sums only the non-empty bins", () => {
      const bins: AmmoBins = {
        "leftTorso:1": 0,
        "leftTorso:2": 5,
      };
      expect(ammoWeaponTotals(HBK, critState(HBK, bins))[4]).toBe(5);
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
        "leftTorso:1": 3,
        "leftTorso:2": 1,
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
        "leftTorso:1": 2,
        "leftTorso:2": 2,
      };
      // even d6 -> Fisher-Yates swap is a no-op, slot 1 leads; odd d6 -> slot 2.
      expect(drawOrderBins(base, counts, "exposed", scriptedRng(2))[0]!.id).toBe("leftTorso:1");
      expect(drawOrderBins(base, counts, "exposed", scriptedRng(1))[0]!.id).toBe("leftTorso:2");
    });
  });

  describe("consumeAmmo", () => {
    const start = (): AmmoBins => ({
      "leftTorso:1": 5,
      "leftTorso:2": 5,
    });

    it("draws each shot from the policy's next bin, ties decided by rng", () => {
      const even = consumeAmmo(HBK, critState(HBK, start()), 4, 1, "exposed", scriptedRng(2));
      expect(even["leftTorso:1"]).toBe(4);
      expect(even["leftTorso:2"]).toBe(5);
      const odd = consumeAmmo(HBK, critState(HBK, start()), 4, 1, "exposed", scriptedRng(1));
      expect(odd["leftTorso:1"]).toBe(5);
      expect(odd["leftTorso:2"]).toBe(4);
    });

    it("switches to another bin when the chosen one runs dry mid-burst", () => {
      const bins: AmmoBins = {
        "leftTorso:1": 1,
        "leftTorso:2": 5,
      };
      const after = consumeAmmo(HBK, critState(HBK, bins), 4, 2, "exposed", scriptedRng(2, 2));
      expect(after["leftTorso:1"]).toBe(0);
      expect(after["leftTorso:2"]).toBe(4);
    });

    it("returns the input untouched when the weapon has no shots left", () => {
      const bins: AmmoBins = {
        "leftTorso:1": 0,
        "leftTorso:2": 0,
      };
      const rng = scriptedRng(2);
      const after = consumeAmmo(HBK, critState(HBK, bins), 4, 1, "exposed", rng);
      expect(after).toEqual(bins);
      expect(rng.remaining()).toBe(1);
    });
  });

  function hbkBattle(): ReturnType<typeof createBattle> {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
    ];
    return createTestBattle([], units, true);
  }

  function attackPhase(state: ReturnType<typeof createBattle>): void {
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
  }

  describe("declareAttacks (game level)", () => {
    it("drains the declared weapon's bins and refreshes derived totals", () => {
      const state = hbkBattle();
      attackPhase(state);
      declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], [], scriptedRng(2));
      const u = requireUnit(state, "hbk")!;
      expect(u.ammoBins["leftTorso:1"]).toBe(4);
      expect(u.ammoBins["leftTorso:2"]).toBe(5);
      expect(ammoWeaponTotals(HBK, u)[4]).toBe(9);
    });

    it("drains one shot per rapid-fire round declared (TW p.103-104)", () => {
      // HER-5SA Ultra AC/5 (weaponIndex 3, 1-based): 20 shots loaded; a double-tap declares 2.
      const units: UnitInit[] = [
        buildUnitInit("her", "HER-5SA", 1, { col: 2, row: 4 }, "ne"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
      ];
      const state = createTestBattle([], units, true);
      attackPhase(state);
      const before = ammoWeaponTotals(HER, requireUnit(state, "her")!)[3];
      expect(before).toBe(20);
      declareAttacks(
        state,
        "her",
        [{ weaponIndex: 3, targetId: "enf", rapidFire: true }],
        [],
        [],
        scriptedRng(6, 6, 6, 6, 6, 6),
      );
      const u = requireUnit(state, "her")!;
      expect(ammoWeaponTotals(HER, u)[3]).toBe(18);
    });

    it("breaks ammo-bin ties by explicit rng", () => {
      const state = hbkBattle();
      attackPhase(state);
      // A roll of 1 breaks the tie toward slot 2.
      declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], [], scriptedRng(1));
      const u = requireUnit(state, "hbk")!;
      expect(u.ammoBins["leftTorso:1"]).toBe(5);
      expect(u.ammoBins["leftTorso:2"]).toBe(4);
    });
  });

  describe("shared ammo pool for twin mounts (TW p.103-104)", () => {
    const mountIndex = (model: string, weapon: string, location: string): number => {
      const def = mechDef(model)!;
      return Number(
        Object.entries(def.weapons).find(
          ([, m]) => m.weapon === weapon && m.location === location,
        )![0],
      );
    };

    it("unbound twins have no direct bin but share the weapon-name pool", () => {
      const bsw = mechDef("BSW-X1")!;
      // Arm LRM 5 (mount 1) and left-torso MG (mount 4) bind no bin; the pool holds them.
      expect(binsForWeapon(bsw, mountIndex("BSW-X1", "LRM 5", "leftArm"))).toEqual([]);
      expect(binsForWeaponName(bsw, "LRM 5").length).toBeGreaterThan(0);
      expect(binsForWeapon(bsw, mountIndex("BSW-X1", "Machine Gun", "leftTorso"))).toEqual([]);
      expect(binsForWeaponName(bsw, "Machine Gun").length).toBeGreaterThan(0);
      const tbr = mechDef("TBR-Prime")!;
      expect(binsForWeapon(tbr, mountIndex("TBR-Prime", "CL LRM 20", "rightTorso"))).toEqual([]);
      expect(binsForWeaponName(tbr, "CL LRM 20").length).toBeGreaterThan(0);
      expect(binsForWeapon(tbr, mountIndex("TBR-Prime", "CL Machine Gun", "rightTorso"))).toEqual(
        [],
      );
      expect(binsForWeaponName(tbr, "CL Machine Gun").length).toBeGreaterThan(0);
    });

    function bswBattle(): ReturnType<typeof createBattle> {
      const units: UnitInit[] = [
        buildUnitInit("bsw", "BSW-X1", 1, { col: 2, row: 4 }, "ne"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
      ];
      return createTestBattle([], units, true);
    }

    function zeroAllBins(state: ReturnType<typeof createBattle>, id: string): void {
      const u = requireUnit(state, id)!;
      for (const k of Object.keys(u.ammoBins)) u.ammoBins[k] = 0;
    }

    it("an unbound twin cannot fire from an empty pool", () => {
      const state = bswBattle();
      attackPhase(state);
      zeroAllBins(state, "bsw");
      const unboundMg = mountIndex("BSW-X1", "Machine Gun", "leftTorso");
      expect(() =>
        declareAttacks(
          state,
          "bsw",
          [{ weaponIndex: unboundMg, targetId: "enf" }],
          [],
          [],
          scriptedRng(6),
        ),
      ).toThrow(/needs 1 shot\(s\) but only 0 remain/);
    });

    it("an unbound twin spends the shared pool", () => {
      const state = bswBattle();
      attackPhase(state);
      const def = mechDef("BSW-X1")!;
      const unboundMg = mountIndex("BSW-X1", "Machine Gun", "leftTorso");
      const before = pooledShotsLeft(def, requireUnit(state, "bsw")!, "Machine Gun");
      expect(before).toBeGreaterThan(1);
      declareAttacks(
        state,
        "bsw",
        [{ weaponIndex: unboundMg, targetId: "enf" }],
        [],
        [],
        scriptedRng(6),
      );
      const after = pooledShotsLeft(def, requireUnit(state, "bsw")!, "Machine Gun");
      expect(after).toBe(before - 1);
    });

    it("twins declaring together cannot overspend the last shot", () => {
      const def = mechDef("BSW-X1")!;
      const unboundMg = mountIndex("BSW-X1", "Machine Gun", "leftTorso");
      const boundMg = mountIndex("BSW-X1", "Machine Gun", "rightTorso");
      const mgBin = collectAmmoBins(def).find((b) => b.weapon === "Machine Gun")!.id;
      const state = bswBattle();
      attackPhase(state);
      zeroAllBins(state, "bsw");
      requireUnit(state, "bsw")!.ammoBins[mgBin] = 1;
      expect(() =>
        declareAttacks(
          state,
          "bsw",
          [
            { weaponIndex: unboundMg, targetId: "enf" },
            { weaponIndex: boundMg, targetId: "enf" },
          ],
          [],
          [],
          scriptedRng(6),
        ),
      ).toThrow(/needs 2 shot\(s\) \(1 already claimed by other mounts\) but only 1 remain/);
      // Nothing was spent: the failed volley leaves the pool intact.
      expect(pooledShotsLeft(def, requireUnit(state, "bsw")!, "Machine Gun")).toBe(1);
    });

    describe("API-F05: suggestions cap pooled mounts at the shared pool", () => {
      it("offers one twin for the last shot and the suggested set declares", () => {
        const unboundMg = mountIndex("BSW-X1", "Machine Gun", "leftTorso");
        const boundMg = mountIndex("BSW-X1", "Machine Gun", "rightTorso");
        const def = mechDef("BSW-X1")!;
        const mgBin = collectAmmoBins(def).find((b) => b.weapon === "Machine Gun")!.id;
        const state = bswBattle();
        attackPhase(state);
        zeroAllBins(state, "bsw");
        requireUnit(state, "bsw")!.ammoBins[mgBin] = 1;
        const target = suggestFireTargets(state, "bsw").targets.find((t) => t.targetId === "enf")!;
        const offered = target.weapons.filter((w) => w.weapon === "Machine Gun");
        expect(offered.map((w) => w.weaponIndex)).toEqual([Math.min(unboundMg, boundMg)]);
        expect(target.blocked).toContainEqual({
          weaponIndex: Math.max(unboundMg, boundMg),
          weapon: "Machine Gun",
          reason: "outOfAmmo",
        });
        expect(() =>
          declareAttacks(
            state,
            "bsw",
            target.weapons.map((w) => ({ weaponIndex: w.weaponIndex, targetId: "enf" })),
            [],
            [],
            scriptedRng(6),
          ),
        ).not.toThrow();
      });

      it("offers every twin while the pool covers them", () => {
        const state = bswBattle();
        attackPhase(state);
        const target = suggestFireTargets(state, "bsw").targets.find((t) => t.targetId === "enf")!;
        expect(target.weapons.filter((w) => w.weapon === "Machine Gun")).toHaveLength(2);
      });
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

  describe("ammoPolicy setup (session)", () => {
    it("sets the policy with `set` during setup and rejects gibberish", () => {
      const s = newSession(42);
      execute(s, "map quickstart");
      execute(s, "add hunchy HBK-4G 9 9 n");
      execute(s, "add cicada CDA-3MA 9 8 s");
      const unit = () => s.setup.roster.find((u) => u.id === "hunchy")!;
      expect(unit().policy).toEqual({
        ammoPolicy: "exposed",
        autoEject: true,
        heatFlamer: true,
        amsPolicy: "expected",
      });
      expect(execute(s, "set hunchy ammoPolicy spread")).toEqual([
        "hunchy: ammoPolicy set to spread",
      ]);
      expect(unit().policy.ammoPolicy).toBe("spread");
      expect(execute(s, "set hunchy AMMOPOLICY leastfirst")[0]).toBe(
        "hunchy: ammoPolicy set to least-first",
      );
      expect(unit().policy.ammoPolicy).toBe("leastFirst");
      expect(execute(s, "set hunchy ammoPolicy nope")[0]).toMatch(
        /^error: ammo policy must be one of/,
      );
      expect(unit().policy.ammoPolicy).toBe("leastFirst");

      execute(s, "start");
      expect(s.battle!.units.hunchy!.ammoPolicy).toBe("leastFirst");
      expect(s.battle!.units.cicada!.ammoPolicy).toBe("exposed");
    });

    it("buildUnitInit defaults the policy; createBattle applies and validates it", () => {
      expect(buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }).policy).toEqual({
        ammoPolicy: "exposed",
        autoEject: true,
        heatFlamer: true,
        amsPolicy: "expected",
      });
      const mk = (policy: UnitInit["policy"]) => [
        { ...buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }), policy },
        buildUnitInit("b", "CDA-3MA", 2, { col: 3, row: 1 }),
      ];
      const state = createTestBattle(
        [],
        mk({ ammoPolicy: "core", autoEject: true, heatFlamer: true, amsPolicy: "expected" }),
        true,
      );
      expect(state.units.a!.ammoPolicy).toBe("core");
      expect(state.units.b!.ammoPolicy).toBe("exposed");
    });

    it("renders the policy line on the record sheet only for ammo-carrying units", () => {
      const s = freshBrawl();
      s.battle!.units.hunchy!.ammoPolicy = "core";
      expect(execute(s, "sheet hunchy").join("\n")).toContain("ammo status: policy(core");
      expect(execute(s, "sheet cicada").join("\n")).not.toContain("ammo policy");
    });
  });
});
