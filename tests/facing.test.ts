import { describe, expect, it } from "vitest";
import {
  FACINGS,
  isFacing,
  oppositeFacing,
  rotateFacing,
} from "../src/core/types.js";

describe("facing helpers", () => {
  it("lists facings clockwise from north", () => {
    expect(FACINGS).toEqual(["n", "ne", "se", "s", "sw", "nw"]);
  });

  it("rotates with wrap-around in both directions", () => {
    expect(rotateFacing("n", 1)).toBe("ne");
    expect(rotateFacing("n", -1)).toBe("nw");
    expect(rotateFacing("se", 1)).toBe("s");
    expect(rotateFacing("ne", 2)).toBe("s");
    expect(rotateFacing("s", 6)).toBe("s");
  });

  it("opposite is a half turn", () => {
    expect(oppositeFacing("n")).toBe("s");
    expect(oppositeFacing("ne")).toBe("sw");
    expect(oppositeFacing("se")).toBe("nw");
    expect(oppositeFacing(oppositeFacing("sw"))).toBe("sw");
  });

  it("validates runtime values (JSON-loaded state)", () => {
    expect(isFacing("ne")).toBe(true);
    expect(isFacing("e")).toBe(false);
    expect(isFacing("E")).toBe(false);
    expect(isFacing(0)).toBe(false);
    expect(isFacing("north")).toBe(false);
    expect(isFacing(undefined)).toBe(false);
  });
});
