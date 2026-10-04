import { describe, expect, it } from "vitest";
import { oppositeFacing, rotateFacing } from "../src/core/types";

describe("facing helpers", () => {
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
});
