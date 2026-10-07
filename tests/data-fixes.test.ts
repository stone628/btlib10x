import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { internalStructureForTonnage } from "../src/rules/internalStructure";

describe("internal structure table matches the TechManual (DATA-01)", () => {
  it.each([
    [30, 10, 7, 5, 7],
    [60, 20, 14, 10, 14],
    [65, 21, 15, 10, 15],
    [85, 27, 18, 14, 18],
  ])("%i t", (tons, ct, side, arm, leg) => {
    const is = internalStructureForTonnage(tons as number);
    expect([is.centerTorso, is.rightTorso, is.rightArm, is.rightLeg]).toEqual([ct, side, arm, leg]);
  });
});

describe("catalog loadouts match their records (DATA-02, DATA-03)", () => {
  const mounts = (model: string, weapon: string, location: string) =>
    Object.values(mechDef(model)!.weapons).filter(
      (w) => w.weapon === weapon && w.location === location,
    ).length;

  it("Warhawk Prime carries two ER PPCs per arm", () => {
    expect(mounts("WHK-Prime", "CL ER PPC", "leftArm")).toBe(2);
    expect(mounts("WHK-Prime", "CL ER PPC", "rightArm")).toBe(2);
  });

  it("Centurion CN9-YLW2 carries two Medium Pulse Lasers in the left arm", () => {
    expect(mounts("CN9-YLW2", "Medium Pulse Laser", "leftArm")).toBe(2);
  });
});
