import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("library version", () => {
  it("is either the dev fallback or a YYMMDD-<hash> stamp", () => {
    // Vitest bundles without the esbuild `define` injection, so this runs the
    // "dev" fallback path; the web bundles carry a real stamp of the same shape.
    expect(VERSION).toMatch(/^dev$|^\d{6}-[0-9a-f]+|nogit$/);
  });
});
