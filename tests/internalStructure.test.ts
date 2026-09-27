import { describe, expect, it } from "vitest";
import { HEAD_STRUCTURE, internalStructureForTonnage } from "../src/rules/internalStructure";

describe("internal structure derivation", () => {
  it("head is always 3 regardless of tonnage", () => {
    expect(HEAD_STRUCTURE).toBe(3);
    for (const tonnage of [20, 40, 50, 55, 90, 100]) {
      expect(internalStructureForTonnage(tonnage).head).toBe(3);
    }
  });

  it("matches canonical record sheets for shipped tonnages", () => {
    const cases: Array<
      [number, { centerTorso: number; sideTorso: number; arm: number; leg: number }]
    > = [
      [40, { centerTorso: 12, sideTorso: 10, arm: 6, leg: 10 }],
      [50, { centerTorso: 16, sideTorso: 12, arm: 8, leg: 12 }],
      [55, { centerTorso: 18, sideTorso: 13, arm: 9, leg: 13 }],
      [90, { centerTorso: 29, sideTorso: 19, arm: 15, leg: 19 }],
      [100, { centerTorso: 31, sideTorso: 21, arm: 17, leg: 21 }],
    ];
    for (const [tonnage, expected] of cases) {
      const is = internalStructureForTonnage(tonnage);
      expect(is.centerTorso).toBe(expected.centerTorso);
      expect(is.rightTorso).toBe(expected.sideTorso);
      expect(is.leftTorso).toBe(expected.sideTorso);
      expect(is.rightArm).toBe(expected.arm);
      expect(is.leftArm).toBe(expected.arm);
      expect(is.rightLeg).toBe(expected.leg);
      expect(is.leftLeg).toBe(expected.leg);
    }
  });

  it("throws for unsupported tonnages", () => {
    expect(() => internalStructureForTonnage(58)).toThrow();
    expect(() => internalStructureForTonnage(0)).toThrow();
  });
});
