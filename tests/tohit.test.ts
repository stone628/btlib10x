import { describe, expect, it } from "vitest";
import { getWeaponDefFor } from "../src/data/weapon.schema.js";
import { computeToHit } from "../src/rules/tohit.js";

describe("GATOR to-hit calculation", () => {
  // Total Warfare, Rolling To Hit diagram (p.106):
  // Wolverine (ran) fires medium laser at Griffin 4 hexes away,
  // light woods intervening; target moved 2 hexes.
  it("matches rulebook example: Wolverine medium laser TN 9", () => {
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "run",
      targetHexesMoved: 2,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 1,
      distance: 4,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(bd.total).toBe(9);
    expect(bd.rangeBracket).toBe("medium");
  });

  // Same diagram: Griffin (walked, gunnery 3) fires PPC back at Wolverine
  // 4 hexes away (short for PPC); light woods between AND target in light woods.
  it("matches rulebook example: Griffin PPC TN 8", () => {
    const bd = computeToHit({
      gunnery: 3,
      attackerMovement: "walk",
      targetHexesMoved: 5,
      targetJumped: false,
      targetTerrain: "lightWoods",
      interveningWoods: 1,
      distance: 4,
      weapon: getWeaponDefFor({ weapon: "PPC" }),
    });
    expect(bd.total).toBe(8);
    expect(bd.rangeBracket).toBe("short");
  });

  // Total Warfare Target Movement diagram (p.107): Cicada fires ML at stationary
  // Enforcer 4 hexes away -> 7. Hunchback AC/20 at Cicada (5 hexes moved),
  // ran, range 2 short -> 8. Enforcer large laser at Hunchback (2 hexes moved),
  // standing still, short range -> 4.
  it("matches the three worked examples on p.107", () => {
    const ml = computeToHit({
      gunnery: 4,
      attackerMovement: "walk",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 4,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(ml.total).toBe(7);

    const ac20 = computeToHit({
      gunnery: 4,
      attackerMovement: "run",
      targetHexesMoved: 5,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 2,
      weapon: getWeaponDefFor({ weapon: "AC/20" }),
    });
    expect(ac20.total).toBe(8);

    const ll = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 2,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 4,
      weapon: getWeaponDefFor({ weapon: "Large Laser" }),
    });
    expect(ll.total).toBe(4);
  });

  it("applies target movement bands and jump bonus", () => {
    const mk = (moved: number, jumped = false) =>
      computeToHit({
        gunnery: 4,
        attackerMovement: "standStill",
        targetHexesMoved: moved,
        targetJumped: jumped,
        targetTerrain: "clear",
        interveningWoods: 0,
        distance: 1,
        weapon: getWeaponDefFor({ weapon: "Small Laser" }),
      }).total;
    expect(mk(2)).toBe(4);
    expect(mk(3)).toBe(5);
    expect(mk(6)).toBe(6);
    expect(mk(9)).toBe(7);
    expect(mk(17)).toBe(8);
    expect(mk(24)).toBe(9);
    expect(mk(25)).toBe(10);
    expect(mk(3, true)).toBe(6);
  });

  it("prone target: -2 adjacent, +1 at range, -4 when immobile", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      weapon: getWeaponDefFor({ weapon: "Small Laser" }),
    };
    const adjacent = computeToHit({ ...base, distance: 1, targetProne: true });
    expect(adjacent.targetMod).toBe(-2);
    const distant = computeToHit({ ...base, distance: 3, targetProne: true });
    expect(distant.targetMod).toBe(1);
    expect(distant.targetMod - adjacent.targetMod).toBe(3);
    const immobileProne = computeToHit({
      ...base,
      distance: 3,
      targetProne: true,
      targetImmobile: true,
    });
    expect(immobileProne.targetMod).toBe(-4);
  });

  it("immobile target (shut down / legs destroyed) gets a flat -4 target modifier", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "run" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      distance: 4,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
    };
    const online = computeToHit(base);
    const immobile = computeToHit({ ...base, targetImmobile: true });
    expect(immobile.targetMod).toBe(-4);
    expect(immobile.total).toBe(online.total - 4);
  });

  it("partial-cover target adds +1 terrain modifier", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "water1" as const,
      interveningWoods: 0,
      distance: 1,
      weapon: getWeaponDefFor({ weapon: "Small Laser" }),
    };
    const plain = computeToHit(base);
    expect(plain.terrainMod).toBe(0);
    const covered = computeToHit({ ...base, partialCoverMod: 1 });
    expect(covered.terrainMod).toBe(1);
    expect(covered.total).toBe(plain.total + 1);
  });

  it("flags auto-hit <= 2 and auto-miss > 12", () => {
    const easy = computeToHit({
      gunnery: 0,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeaponDefFor({ weapon: "Small Laser" }),
    });
    expect(easy.automatic).toBe("hit");
    expect(easy.pulseMod).toBe(0);

    const pulse = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeaponDefFor({ weapon: "Small Pulse Laser" }),
    });
    expect(pulse.pulseMod).toBe(-2);

    const hard = computeToHit({
      gunnery: 7,
      attackerMovement: "jump",
      targetHexesMoved: 25,
      targetJumped: false,
      targetTerrain: "heavyWoods",
      interveningWoods: 2,
      distance: 15,
      weapon: getWeaponDefFor({ weapon: "Large Laser" }),
    });
    expect(hard.automatic).toBe("miss");
  });

  it("marks out-of-range shots as automatic misses", () => {
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 10,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(bd.outOfRange).toBe(true);
    expect(bd.automatic).toBe("miss");
  });

  it("applies the closer-than-minimum-range penalty", () => {
    const gauss = getWeaponDefFor({ weapon: "CL Gauss Rifle" });
    expect(gauss.minRange).toBe(2);

    const at = (distance: number) =>
      computeToHit({
        gunnery: 4,
        attackerMovement: "standStill",
        targetHexesMoved: 0,
        targetJumped: false,
        targetTerrain: "clear",
        interveningWoods: 0,
        distance,
        weapon: gauss,
      });

    expect(at(1).minRangeMod).toBe(2);
    expect(at(1).total).toBe(6); // gunnery 4 + min (2-1+1) 2
    expect(at(2).minRangeMod).toBe(1);
    expect(at(2).total).toBe(5); // gunnery 4 + min (2-2+1) 1
    expect(at(3).minRangeMod).toBe(0);
    expect(at(3).total).toBe(4); // within short range, no penalty
  });

  it("resolves variable damage per bracket (Snub-Nose PPC V10/8/5)", () => {
    const snub = getWeaponDefFor({ weapon: "Snub-Nose PPC" });
    const short = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 9,
      weapon: snub,
    });
    expect(short.rangeBracket).toBe("short");
  });
});
