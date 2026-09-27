import { describe, expect, it } from "vitest";
import { clusterHits, groupMissiles } from "../src/rules/cluster";
import {
  HIT_LOCATION_TABLE,
  hitLocation,
  hitLocationForArc,
  LEFT_SIDE_TABLE,
  RIGHT_SIDE_TABLE,
} from "../src/rules/hitlocation";

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
  it("matches the missile table (TW p. 116)", () => {
    expect(clusterHits(2, 2)).toBe(1);
    expect(clusterHits(2, 12)).toBe(2);
    expect(clusterHits(4, 11)).toBe(4);
    expect(clusterHits(5, 4)).toBe(2);
    expect(clusterHits(6, 8)).toBe(4);
    expect(clusterHits(10, 9)).toBe(8);
    expect(clusterHits(10, 12)).toBe(10);
    expect(clusterHits(15, 11)).toBe(15);
    expect(clusterHits(20, 7)).toBe(12);
    expect(clusterHits(20, 12)).toBe(20);
  });

  it("matches the full weapon-size columns incl. large launchers", () => {
    expect(clusterHits(30, 2)).toBe(10);
    expect(clusterHits(30, 4)).toBe(12);
    expect(clusterHits(30, 9)).toBe(24);
    expect(clusterHits(40, 2)).toBe(12);
    expect(clusterHits(40, 4)).toBe(18);
    expect(clusterHits(40, 5)).toBe(24);
    expect(clusterHits(40, 9)).toBe(32);
    expect(clusterHits(40, 11)).toBe(40);
    expect(clusterHits(7, 6)).toBe(4);
    expect(clusterHits(13, 8)).toBe(8);
  });

  it("shares the same table for rapid-fire shots (2/3/4)", () => {
    expect(clusterHits(2, 2)).toBe(1);
    expect(clusterHits(2, 12)).toBe(2);
    expect(clusterHits(3, 7)).toBe(2);
    expect(clusterHits(4, 11)).toBe(4);
  });

  it("groups LRM missiles into lots of five", () => {
    expect(groupMissiles(10, 5)).toEqual([5, 5]);
    expect(groupMissiles(8, 5)).toEqual([5, 3]);
    expect(groupMissiles(3, 5)).toEqual([3]);
  });
});
