import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanImage, cleanName, parseMulPage } from "../functions/api/ag/_lib/mul";
// @ts-expect-error -- plain .mjs build helper, no type declarations
import { stripHomeLink } from "../scripts/standalone-strip.mjs";
import {
  avatarLines,
  canonicalAvatar,
  isUnitSlug,
  keyPublicId,
  parseMulUrl,
  prettifySlug,
  publicId,
} from "../web/avatar/avatar.gallery";
import { keyFromText } from "../web/avatar/gallery.key";
import { afterSubmit } from "../web/avatar/gallery.submit";

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

describe("afterSubmit", () => {
  it("shows a new, published avatar first under 'new'", () => {
    expect(afterSubmit({ id: 7, existing: false, pending: false }, "")).toEqual({
      view: "sort=new",
      notice: "submitted",
      highlight: 7,
    });
  });

  it("opens the page of an avatar awaiting approval", () => {
    expect(afterSubmit({ id: 7, existing: false, pending: true }, "")).toEqual({
      view: "id=7",
      notice: "submittedPending",
      highlight: null,
    });
  });

  it("opens the original's page for a duplicate, with or without a 'Mech", () => {
    const mul = "https://masterunitlist.battletech.com/units/atlas-as7-d";
    expect(afterSubmit({ id: 3, existing: true }, mul)).toEqual({
      view: "id=3",
      notice: "alreadyThere",
      highlight: null,
    });
    expect(afterSubmit({ id: 3, existing: true }, "")).toMatchObject({
      notice: "alreadyThereNoMech",
    });
    // A lost insert race can come back without an id.
    expect(afterSubmit({ id: null, existing: true }, "")).toMatchObject({ view: "sort=new" });
  });
});

describe("home-link", () => {
  const page = (name: string) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");

  describe("landing page link", () => {
    for (const name of ["terminal.html", "avatar.html", "gallery.html", "glyphart.html"]) {
      it(`${name} links home as the last item of its top row`, () => {
        const html = page(name);
        const link = html.match(
          /<a id="home-link" class="link-button" href="\.\/"[^>]*>(.*?)<\/a>/,
        );
        expect(link).not.toBeNull();
        expect(link?.[1]).toContain("← bt10x");
        expect(link?.[1]).toContain('<span lang="en">bt10x home</span>');
        expect(link?.[1]).toContain('<span lang="ko">bt10x 홈</span>');
        // Rightmost: nothing but the closing marker comes before the row ends.
        const after = html.slice((link?.index ?? 0) + (link?.[0].length ?? 0));
        expect(after).toMatch(/^\s*(<!-- \/home-link -->\s*)?<\/(header|div)>/);
      });
    }

    it("is stripped from the standalone terminal", () => {
      const html = page("terminal.html");
      const out = stripHomeLink(html);
      expect(out).not.toContain("home-link");
      expect(out).toContain('id="motd-open"');
      expect(() => stripHomeLink(out)).toThrow(/markers not found/);
    });
  });
});

describe("gallery-key", () => {
  /** Reading a moved device key from what the player pasted (web/avatar/gallery.key.ts). */
  describe("keyFromText", () => {
    const key = "Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC";

    it("takes a bare key, trimmed", () => {
      expect(key).toHaveLength(43);
      expect(keyFromText(`  ${key}\n`)).toBe(key);
    });

    it("takes a copied key link", () => {
      expect(keyFromText(`https://bt10x.stoneworks.dev/gallery#key=${key}`)).toBe(key);
      expect(keyFromText(`gallery.html?lang=ko#key=${key}`)).toBe(key);
    });

    it("refuses anything else", () => {
      expect(keyFromText("")).toBeNull();
      expect(keyFromText(key.slice(1))).toBeNull();
      expect(keyFromText(`${key}!`)).toBeNull();
      expect(keyFromText(`https://bt10x.stoneworks.dev/gallery#key=${key.slice(2)}`)).toBeNull();
      expect(keyFromText("https://bt10x.stoneworks.dev/gallery#id=3")).toBeNull();
    });
  });
});
