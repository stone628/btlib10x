import { describe, expect, it } from "vitest";
import {
  clusterHitsForMissiles,
  clusterHitsForShots,
  groupMissiles,
} from "../src/rules/cluster.js";
import {
  HIT_LOCATION_TABLE,
  hitLocation,
  hitLocationForArc,
  LEFT_SIDE_TABLE,
  RIGHT_SIDE_TABLE,
} from "../src/rules/hitlocation.js";

describe("hit location table", () => {
  it("maps every 2D6 result per the record sheets", () => {
    expect(hitLocation(2)).toBe("centerTorso");
    expect(hitLocation(3)).toBe("rightArm");
    expect(hitLocation(4)).toBe("rightArm");
    expect(hitLocation(5)).toBe("rightLeg");
    expect(hitLocation(6)).toBe("rightTorso");
    expect(hitLocation(7)).toBe("centerTorso");
    expect(hitLocation(8)).toBe("leftTorso");
    expect(hitLocation(9)).toBe("leftLeg");
    expect(hitLocation(10)).toBe("leftArm");
    expect(hitLocation(11)).toBe("leftArm");
    expect(hitLocation(12)).toBe("head");
  });

  it("rejects impossible rolls", () => {
    expect(() => hitLocation(1)).toThrow();
    expect(() => hitLocation(13)).toThrow();
  });

  it("front and rear arcs share the front/rear column", () => {
    for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(hitLocationForArc("front", roll)).toBe(HIT_LOCATION_TABLE[roll]);
      expect(hitLocationForArc("rear", roll)).toBe(HIT_LOCATION_TABLE[roll]);
    }
  });

  it("uses the left-side table for the left side arc", () => {
    for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(hitLocationForArc("leftSide", roll)).toBe(LEFT_SIDE_TABLE[roll]);
    }
    expect(hitLocationForArc("leftSide", 2)).toBe("leftTorso");
    expect(hitLocationForArc("leftSide", 8)).toBe("centerTorso");
  });

  it("uses the right-side table for the right side arc", () => {
    for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(hitLocationForArc("rightSide", roll)).toBe(RIGHT_SIDE_TABLE[roll]);
    }
    expect(hitLocationForArc("rightSide", 2)).toBe("rightTorso");
    expect(hitLocationForArc("rightSide", 8)).toBe("centerTorso");
  });

  it("rejects impossible rolls for every arc", () => {
    for (const arc of ["front", "rear", "leftSide", "rightSide"] as const) {
      expect(() => hitLocationForArc(arc, 1)).toThrow();
      expect(() => hitLocationForArc(arc, 13)).toThrow();
    }
  });
});

describe("cluster hits tables", () => {
  it("matches the missile table (columns 2/4/5/6/10/15/20)", () => {
    expect(clusterHitsForMissiles(2, 2)).toBe(1);
    expect(clusterHitsForMissiles(2, 12)).toBe(2);
    expect(clusterHitsForMissiles(4, 11)).toBe(4);
    expect(clusterHitsForMissiles(5, 4)).toBe(2);
    expect(clusterHitsForMissiles(6, 8)).toBe(4);
    expect(clusterHitsForMissiles(10, 9)).toBe(8);
    expect(clusterHitsForMissiles(10, 12)).toBe(10);
    expect(clusterHitsForMissiles(15, 11)).toBe(15);
    expect(clusterHitsForMissiles(20, 7)).toBe(12);
    expect(clusterHitsForMissiles(20, 12)).toBe(20);
  });

  it("matches the rapid-fire shot table (columns 2/3/4)", () => {
    expect(clusterHitsForShots(2, 2)).toBe(1);
    expect(clusterHitsForShots(2, 12)).toBe(2);
    expect(clusterHitsForShots(3, 7)).toBe(2);
    expect(clusterHitsForShots(4, 11)).toBe(4);
  });

  it("groups LRM missiles into lots of five", () => {
    expect(groupMissiles(10, 5)).toEqual([5, 5]);
    expect(groupMissiles(8, 5)).toEqual([5, 3]);
    expect(groupMissiles(3, 5)).toEqual([3]);
  });
});
