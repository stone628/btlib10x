import { describe, expect, it } from "vitest";
import { buildAvatarQuery, parseAvatarQuery, parseGlyphParam } from "../web/avatar/avatar.url";

const PARTS = [
  { key: "head", names: ["sr", "sq"] },
  { key: "shoulder", names: ["no", "rn"] },
  { key: "torso", names: ["rs", "bt"] },
  { key: "arms", names: ["ss", "pr"] },
  { key: "legs", names: ["ss", "sf"] },
];

describe("avatar URL params", () => {
  it("returns null when no avatar params are present", () => {
    expect(parseAvatarQuery("", PARTS)).toBeNull();
    expect(parseAvatarQuery("?foo=1", PARTS)).toBeNull();
  });

  it("reads variants by name, defaulting the parts it leaves out", () => {
    const s = parseAvatarQuery("?head=sq&torso=bt", PARTS)!;
    expect(s.idx).toEqual([1, 0, 1, 0, 0]);
    expect(s.ovr).toEqual({});
  });

  it("reads overrides as hex code points or literal characters", () => {
    const s = parseAvatarQuery(`?rh=2622&la=23AC&rl=0020&lt=${encodeURIComponent("☢")}`, PARTS)!;
    expect(s.ovr).toEqual({ RH: "☢", LA: "⎬", RL: " ", LT: "☢" });
  });

  it("ignores unknown variants and glyphs the font lacks", () => {
    const s = parseAvatarQuery("?head=zz&rh=ac00&lh=ab&ra=2622", PARTS)!;
    expect(s.idx[0]).toBe(0);
    expect(s.ovr).toEqual({ RA: "☢" });
    expect(s.ignored).toEqual(["head=zz", "rh=ac00", "lh=ab"]);
  });

  it("keeps an override next to a variant param for the same part", () => {
    expect(parseAvatarQuery("?torso=bt&rt=2622", PARTS)!.ovr).toEqual({ RT: "☢" });
  });

  it("round-trips through buildAvatarQuery", () => {
    const q = buildAvatarQuery(PARTS, [1, 1, 0, 1, 0], { RH: "☢", LL: " " });
    expect(q).toBe("head=sq&shoulder=rn&torso=rs&arms=pr&legs=ss&rh=2622&ll=0020");
    const s = parseAvatarQuery(`?${q}`, PARTS)!;
    expect(s.idx).toEqual([1, 1, 0, 1, 0]);
    expect(s.ovr).toEqual({ RH: "☢", LL: " " });
  });

  it("parses single glyph values", () => {
    expect(parseGlyphParam("2")).toBe("2");
    expect(parseGlyphParam("110000")).toBeNull();
    expect(parseGlyphParam("")).toBeNull();
  });
});
