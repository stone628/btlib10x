import { describe, expect, it } from "vitest";
import { clusterHits, expectedClusterHits, modifiedClusterRoll } from "../src/rules/cluster";

describe("modifiedClusterRoll (HAG range mod, TW p.136)", () => {
  it("adds the modifier to the 2D6 roll", () => {
    expect(modifiedClusterRoll(7, 2)).toBe(9);
    expect(modifiedClusterRoll(7, 0)).toBe(7);
    expect(modifiedClusterRoll(7, -2)).toBe(5);
  });

  it("clamps results below 2 up to 2 and above 12 down to 12", () => {
    expect(modifiedClusterRoll(2, -2)).toBe(2);
    expect(modifiedClusterRoll(3, -2)).toBe(2);
    expect(modifiedClusterRoll(12, 2)).toBe(12);
    expect(modifiedClusterRoll(11, 2)).toBe(12);
    expect(modifiedClusterRoll(2, 0)).toBe(2);
    expect(modifiedClusterRoll(12, 0)).toBe(12);
  });

  it("feeds the Cluster Hits Table through clusterHits", () => {
    // 20-column, roll 6 -> 12 hits; the +2 short-range mod turns a raw 4 into that row.
    expect(clusterHits(20, modifiedClusterRoll(4, 2))).toBe(clusterHits(20, 6));
    expect(clusterHits(20, modifiedClusterRoll(4, 2))).toBe(12);
  });
});

describe("expectedClusterHits", () => {
  it("averages the Cluster Hits Table over 2D6 (TW p. 116)", () => {
    // Column 2: rolls 2-7 hit once (21 of 36 ways), rolls 8-12 hit twice (15 ways).
    expect(expectedClusterHits(2)).toBeCloseTo(51 / 36, 10);
    // Column 40 tops out at 40 and never drops below 12.
    expect(expectedClusterHits(40)).toBeGreaterThan(12);
    expect(expectedClusterHits(40)).toBeLessThan(40);
  });
});
