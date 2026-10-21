import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs build helper, no type declarations
import { stripHomeLink } from "../scripts/standalone-strip.mjs";

const page = (name: string) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");

describe("landing page link", () => {
  for (const name of ["terminal.html", "avatar.html", "gallery.html", "glyphart.html"]) {
    it(`${name} links home as the last item of its top row`, () => {
      const html = page(name);
      const link = html.match(/<a id="home-link" class="link-button" href="\.\/"[^>]*>(.*?)<\/a>/);
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
