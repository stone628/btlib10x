import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const dest = "dist/web";

// Files copied from web/ into dist/web/: a bare name keeps its path, a
// [source, target] pair publishes it under another path. Add new pages here.
const FILES = [
  "index.html",
  // A top-level 404.html stops Pages from serving index.html for unknown paths.
  "404.html",
  "landing.css",
  "terminal.html",
  "bt10x.css",
  "terminal.css",
  "btlib10x.js",
  "btlib10x.jsonl",
  "btlib10x.sw.jsonl",
  "terminal.js",
  "avatar.html",
  "avatar.css",
  "avatar.js",
  "gallery.html",
  "gallery.css",
  "gallery.js",
  "gallery-admin.js",
  "glyphart.html",
  "tui.css",
  "tui.js",
  // The admin page lives at /avatar/admin, the path Cloudflare Access guards.
  ["gallery-admin.html", "avatar/admin.html"],
  "VISION.md",
  "favicon.ico",
  ...readdirSync("web/fonts").map((f) => `fonts/${f}`),
];

rmSync(dest, { recursive: true, force: true });
const written = [];
for (const entry of FILES) {
  const [from, to] = typeof entry === "string" ? [entry, entry] : entry;
  mkdirSync(dirname(`${dest}/${to}`), { recursive: true });
  copyFileSync(`web/${from}`, `${dest}/${to}`);
  written.push(to);
}
// Cloudflare Pages only edge-compresses compressible Content-Types; .jsonl
// is not one, so serve the catalog as application/json to get gzip/brotli.
writeFileSync(
  `${dest}/_headers`,
  "/btlib10x.jsonl\n  Content-Type: application/json; charset=utf-8\n" +
    "/btlib10x.sw.jsonl\n  Content-Type: application/json; charset=utf-8\n" +
    // File names carry the JuliaMono version, so a new release is a new URL.
    // CORS lets the avatar creator's HTML snippet load the font on other sites.
    "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n" +
    "  Access-Control-Allow-Origin: *\n" +
    "/avatar/admin*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n",
);
written.push("_headers");
console.log(`dist/web: ${written.join(", ")}`);
