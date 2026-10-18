import { describe, expect, it } from "vitest";
import { cleanImage, cleanName, parseMulPage } from "../functions/api/ag/_lib/mul";
import {
  avatarLines,
  canonicalAvatar,
  isUnitSlug,
  keyPublicId,
  parseMulUrl,
  prettifySlug,
  publicId,
} from "../web/avatar/avatar.gallery";

const BASE = "head=sq&shoulder=no&torso=no&arms=no&legs=no";

describe("canonicalAvatar", () => {
  it("accepts a complete avatar and keeps its canonical order", () => {
    expect(canonicalAvatar("legs=no&arms=no&torso=no&shoulder=no&head=sq")).toBe(BASE);
  });

  it("rejects missing parts, unknown params, unknown variants and bad glyphs", () => {
    expect(canonicalAvatar("head=sq")).toBeNull();
    expect(canonicalAvatar(`${BASE}&x=1`)).toBeNull();
    expect(canonicalAvatar(BASE.replace("head=sq", "head=zz"))).toBeNull();
    expect(canonicalAvatar(`${BASE}&rh=ac00`)).toBeNull();
    expect(canonicalAvatar(`${BASE}&head=sq`)).toBeNull();
    expect(canonicalAvatar(`${BASE}&rh=${"a".repeat(500)}`)).toBeNull();
  });

  it("stores overrides as hex and drops ones that repeat the variant glyph", () => {
    expect(canonicalAvatar(`${BASE}&rh=${encodeURIComponent("☢")}`)).toBe(`${BASE}&rh=2622`);
    // `sq` draws ┌┐, so ┌ on the right-head slot changes nothing.
    expect(canonicalAvatar(`${BASE}&rh=250c`)).toBe(BASE);
  });

  it("draws the stored avatar like the creator", () => {
    expect(avatarLines(`${BASE}&rh=2622`, true)).toEqual([
      "╔════╗",
      "║ ☢┐ ║",
      "║    ║",
      "║    ║",
      "╚════╝",
    ]);
  });
});

describe("MUL unit URLs", () => {
  it("takes the slug from a unit page URL", () => {
    const url = "https://masterunitlist.battletech.com/units/atlas-as7-d-dc";
    expect(parseMulUrl(url)).toBe("atlas-as7-d-dc");
    expect(parseMulUrl(` ${url}/?x=1#top `)).toBe("atlas-as7-d-dc");
    expect(parseMulUrl("http://MasterUnitList.battletech.com/units/Atlas-AS7-D")).toBe(
      "atlas-as7-d",
    );
  });

  it("refuses anything else", () => {
    for (const bad of [
      "masterunitlist.battletech.com/units/atlas",
      "https://evil.example/units/atlas",
      "https://masterunitlist.battletech.com.evil.example/units/atlas",
      "https://user@masterunitlist.battletech.com/units/atlas",
      "https://masterunitlist.battletech.com:8443/units/atlas",
      "https://masterunitlist.battletech.com/units/atlas/card.png",
      "https://masterunitlist.battletech.com/Unit/Details/140/atlas-as7-d",
      "https://masterunitlist.battletech.com/units/<script>",
      "javascript:alert(1)",
    ]) {
      expect(parseMulUrl(bad), bad).toBeNull();
    }
    expect(isUnitSlug("a".repeat(81))).toBe(false);
  });

  it("guesses a readable name from the slug", () => {
    expect(prettifySlug("atlas-as7-d-dc")).toBe("Atlas AS7-D-DC");
    expect(prettifySlug("hunchback-hbk-4g")).toBe("Hunchback HBK-4G");
    expect(prettifySlug("mad-cat-prime")).toBe("Mad Cat Prime");
  });
});

describe("MUL page parsing", () => {
  const page = `<html><head><title>Atlas AS7-D-DC - Master Unit List</title>
    <meta content="Atlas AS7-D-DC" property="og:title">
    <meta property='og:image' content='https://masterunitlist.battletech.com/point-backs/unit-art/manual/atlas-60d7b0.webp'>
    </head></html>`;

  it("reads og:title and og:image", () => {
    expect(parseMulPage(page)).toEqual({
      name: "Atlas AS7-D-DC",
      image: "https://masterunitlist.battletech.com/point-backs/unit-art/manual/atlas-60d7b0.webp",
    });
  });

  it("falls back to <title> and refuses off-site images", () => {
    expect(
      parseMulPage(
        '<title>Mad Cat &amp; Co | Master Unit List</title><meta property="og:image" content="https://cdn.example/x.png">',
      ),
    ).toEqual({ name: "Mad Cat & Co", image: null });
  });

  it("cleans names and image URLs", () => {
    expect(cleanName("  <b>Atlas</b>\u0000 ")).toBe("bAtlas/b");
    expect(cleanName("x".repeat(81))).toBeNull();
    expect(cleanName("Mad Cat (Timber Wolf) Prime · Master Unit List")).toBe(
      "Mad Cat (Timber Wolf) Prime",
    );
    expect(cleanImage("/point-backs/unit-art/a.webp")).toBe(
      "https://masterunitlist.battletech.com/point-backs/unit-art/a.webp",
    );
    expect(cleanImage("http://masterunitlist.battletech.com/a.webp")).toBeNull();
    expect(cleanImage("javascript:alert(1)")).toBeNull();
  });
});

describe("publicId", () => {
  it("is 8 base58 chars, stable per key, and the same from the key or its hash", async () => {
    const key = "A".repeat(43);
    const id = await keyPublicId(key);
    expect(id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
    expect(await keyPublicId(key)).toBe(id);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    expect(await publicId(hash)).toBe(id);
    expect(await keyPublicId("B".repeat(43))).not.toBe(id);
  });
});
