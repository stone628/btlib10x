import { describe, expect, it } from "vitest";
import { keyFromText } from "../web/avatar/gallery.key";

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
