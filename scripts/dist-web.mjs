import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync("web/index.html", `${dest}/index.html`);
copyFileSync("web/landing.css", `${dest}/landing.css`);
copyFileSync("web/terminal.html", `${dest}/terminal.html`);
copyFileSync("web/bt10x.css", `${dest}/bt10x.css`);
copyFileSync("web/btlib10x.js", `${dest}/btlib10x.js`);
copyFileSync("web/btlib10x.jsonl", `${dest}/btlib10x.jsonl`);
copyFileSync("web/btlib10x.sw.jsonl", `${dest}/btlib10x.sw.jsonl`);
copyFileSync("web/terminal.js", `${dest}/terminal.js`);
copyFileSync("web/avatar.html", `${dest}/avatar.html`);
copyFileSync("web/avatar.css", `${dest}/avatar.css`);
copyFileSync("web/avatar.js", `${dest}/avatar.js`);
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
    "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n",
);
console.log(
  `dist/web: ${["index.html", "landing.css", "terminal.html", "bt10x.css", "btlib10x.js", "btlib10x.jsonl", "btlib10x.sw.jsonl", "terminal.js", "avatar.html", "avatar.css", "avatar.js", "VISION.md", "favicon.ico", "_headers", ...fonts.map((f) => `fonts/${f}`)].join(", ")}`,
);
