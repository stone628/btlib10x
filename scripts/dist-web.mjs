import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// `--no-gallery` builds the static-only site for GitHub Pages (`npm run
// dist:pages`): no avatar gallery, whose API is Cloudflare Pages Functions,
// and no Cloudflare _headers. The default builds the Cloudflare site.
const noGallery = process.argv.includes("--no-gallery");
const dest = noGallery ? "dist/pages" : "dist/web";

// Gallery files the --no-gallery build leaves out (published paths).
const GALLERY_FILES = new Set([
  "gallery.html",
  "gallery.css",
  "gallery.js",
  "gallery-admin.js",
  "avatar/admin.html",
]);
// Pages linking to the gallery: --no-gallery marks their <html> with
// data-gallery="off", and bt10x.css hides their .needs-gallery elements.
const GALLERY_LINKERS = ["index.html", "avatar.html"];

// URL path the site is served under: "/" on Cloudflare Pages (the default),
// "/btlib10x/" for the GitHub Pages project site. Every page links with
// relative paths, so only 404.html (served at any depth) needs to know it.
const base = `/${(process.env.SITE_BASE ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

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
  "btlib10x.d.ts",
  "btlib10x.jsonl",
  "btlib10x.sw.jsonl",
  "terminal.js",
  "instant.html",
  "instant.css",
  "instant.js",
  "avatar.html",
  "avatar.css",
  "avatar.js",
  "gallery.html",
  "gallery.css",
  "gallery.js",
  "gallery-admin.js",
  "glyphart.html",
  "glyphpaint.html",
  "tui.css",
  "tui.js",
  "tui-demo.html",
  "tui-demo.i18n.js",
  // The admin page lives at /avatar/admin, the path Cloudflare Access guards.
  ["gallery-admin.html", "avatar/admin.html"],
  "VISION.md",
  "favicon.ico",
  ...readdirSync("web/fonts").map((f) => `fonts/${f}`),
];

// Instant-Action-only map pack, present after `npm run pack:ia`.
if (existsSync("web/btlib10x.ia.jsonl")) FILES.push("btlib10x.ia.jsonl");

rmSync(dest, { recursive: true, force: true });
const written = [];
for (const entry of FILES) {
  const [from, to] = typeof entry === "string" ? [entry, entry] : entry;
  if (noGallery && GALLERY_FILES.has(to)) continue;
  mkdirSync(dirname(`${dest}/${to}`), { recursive: true });
  copyFileSync(`web/${from}`, `${dest}/${to}`);
  written.push(to);
}
/** Replaces `from` once in a published page, failing the build if it is gone. */
function rewrite(page, from, to) {
  const html = readFileSync(`${dest}/${page}`, "utf8");
  if (!html.includes(from)) throw new Error(`${page}: ${from} not found`);
  writeFileSync(`${dest}/${page}`, html.replace(from, to));
}
if (base !== "/") rewrite("404.html", '<base href="/" />', `<base href="${base}" />`);
if (noGallery) {
  for (const page of GALLERY_LINKERS) {
    rewrite(page, '<html lang="en">', '<html lang="en" data-gallery="off">');
  }
}
// Cloudflare Pages only edge-compresses compressible Content-Types; .jsonl
// is not one, so serve the catalog as application/json to get gzip/brotli.
// GitHub Pages ignores _headers, so the --no-gallery build skips it.
if (!noGallery) {
  writeFileSync(
    `${dest}/_headers`,
    "/btlib10x.jsonl\n  Content-Type: application/json; charset=utf-8\n" +
      "/btlib10x.sw.jsonl\n  Content-Type: application/json; charset=utf-8\n" +
      "/btlib10x.ia.jsonl\n  Content-Type: application/json; charset=utf-8\n" +
      // File names carry the JuliaMono version, so a new release is a new URL.
      // CORS lets the avatar creator's HTML snippet load the font on other sites.
      "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n" +
      "  Access-Control-Allow-Origin: *\n" +
      "/avatar/admin*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n",
  );
  written.push("_headers");
}
console.log(`${dest} (base ${base}): ${written.join(", ")}`);
