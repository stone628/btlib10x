import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync("web/index.html", `${dest}/index.html`);
// A top-level 404.html stops Pages from serving index.html for unknown paths.
copyFileSync("web/404.html", `${dest}/404.html`);
copyFileSync("web/landing.css", `${dest}/landing.css`);
copyFileSync("web/terminal.html", `${dest}/terminal.html`);
copyFileSync("web/bt10x.css", `${dest}/bt10x.css`);
copyFileSync("web/terminal.css", `${dest}/terminal.css`);
copyFileSync("web/btlib10x.js", `${dest}/btlib10x.js`);
copyFileSync("web/btlib10x.jsonl", `${dest}/btlib10x.jsonl`);
copyFileSync("web/btlib10x.sw.jsonl", `${dest}/btlib10x.sw.jsonl`);
copyFileSync("web/terminal.js", `${dest}/terminal.js`);
copyFileSync("web/avatar.html", `${dest}/avatar.html`);
copyFileSync("web/avatar.css", `${dest}/avatar.css`);
copyFileSync("web/avatar.js", `${dest}/avatar.js`);
copyFileSync("web/gallery.html", `${dest}/gallery.html`);
copyFileSync("web/gallery.css", `${dest}/gallery.css`);
copyFileSync("web/gallery.js", `${dest}/gallery.js`);
copyFileSync("web/gallery-admin.js", `${dest}/gallery-admin.js`);
copyFileSync("web/tui.css", `${dest}/tui.css`);
copyFileSync("web/tui.js", `${dest}/tui.js`);
// The admin page lives at /avatar/admin, the path Cloudflare Access guards.
mkdirSync(`${dest}/avatar`, { recursive: true });
copyFileSync("web/gallery-admin.html", `${dest}/avatar/admin.html`);
copyFileSync("web/VISION.md", `${dest}/VISION.md`);
copyFileSync("web/favicon.ico", `${dest}/favicon.ico`);
mkdirSync(`${dest}/fonts`, { recursive: true });
const fonts = readdirSync("web/fonts");
for (const f of fonts) copyFileSync(`web/fonts/${f}`, `${dest}/fonts/${f}`);
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
console.log(
  `dist/web: ${["index.html", "404.html", "landing.css", "terminal.html", "bt10x.css", "terminal.css", "btlib10x.js", "btlib10x.jsonl", "btlib10x.sw.jsonl", "terminal.js", "avatar.html", "avatar.css", "avatar.js", "gallery.html", "gallery.css", "gallery.js", "gallery-admin.js", "tui.css", "tui.js", "avatar/admin.html", "VISION.md", "favicon.ico", "_headers", ...fonts.map((f) => `fonts/${f}`)].join(", ")}`,
);
