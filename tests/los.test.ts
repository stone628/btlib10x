import { describe, expect, it } from "vitest";
import { losBlockedByElevation, losClear } from "../src/rules/los.js";

describe("losBlockedByElevation", () => {
  it("a level-0 attacker can see a level-0 target across a clear valley", () => {
    const elevation: Record<string, number> = {};
    expect(losBlockedByElevation(elevation, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(false);
  });

  it("a level-1 ridge blocks LOS between two level-0 'Mechs two hexes apart", () => {
    // Ridge at (1,0); attacker at (0,0); target at (2,0). The ray sits at
    // LOS level 1 (hex level + 1, since both endpoints are level 0); the
    // ridge's top is at level 2, which meets/exceeds the ray → blocks.
    const elevation: Record<string, number> = { "1,0": 1 };
    expect(losBlockedByElevation(elevation, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(true);
  });

  it("a level-2 attacker can see a level-0 target over a level-1 ridge", () => {
    // Attacker at (0,0) L2, ridge at (1,0) L1, target at (2,0) L0. Ray goes
    // from LOS level 3 down to LOS level 1, so at the ridge's center it sits
    // at 2; ridge top is at 2, which does not strictly exceed the ray → clear.
    const elevation: Record<string, number> = { "0,0": 2, "1,0": 1, "2,0": 0 };
    expect(losBlockedByElevation(elevation, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(false);
  });

  it("a tall intervening peak blocks LOS even from a higher attacker", () => {
    // Attacker at (0,0) L1, peak at (1,0) L5, target at (2,0) L0.
    // Ray from LOS 2 to LOS 1 is essentially flat; peak top is L6, well
    // above the ray → blocks.
    const elevation: Record<string, number> = { "0,0": 1, "1,0": 5, "2,0": 0 };
    expect(losBlockedByElevation(elevation, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(true);
  });
});

describe("losClear", () => {
  it("passes when both woods and elevation are clear", () => {
    expect(losClear({}, {}, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(true);
  });

  it("fails when elevation blocks even with no woods", () => {
    const elevation: Record<string, number> = { "1,0": 1 };
    expect(losClear(elevation, {}, { col: 0, row: 0 }, { col: 2, row: 0 })).toBe(false);
  });
});
