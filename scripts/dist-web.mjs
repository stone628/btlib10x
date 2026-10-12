import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync("web/index.html", `${dest}/index.html`);
copyFileSync("web/bt10x.css", `${dest}/bt10x.css`);
copyFileSync("web/btlib10x.js", `${dest}/btlib10x.js`);
copyFileSync("web/btlib10x.jsonl", `${dest}/btlib10x.jsonl`);
copyFileSync("web/bt10x.js", `${dest}/bt10x.js`);
copyFileSync("web/avatar.html", `${dest}/avatar.html`);
copyFileSync("web/avatar.css", `${dest}/avatar.css`);
copyFileSync("web/avatar.js", `${dest}/avatar.js`);
copyFileSync("web/VISION.md", `${dest}/VISION.md`);
copyFileSync("web/favicon.ico", `${dest}/favicon.ico`);
// Cloudflare Pages only edge-compresses compressible Content-Types; .jsonl
// is not one, so serve the catalog as application/json to get gzip/brotli.
writeFileSync(
  `${dest}/_headers`,
  "/btlib10x.jsonl\n  Content-Type: application/json; charset=utf-8\n",
);
console.log(
  `dist/web: ${["index.html", "bt10x.css", "btlib10x.js", "btlib10x.jsonl", "bt10x.js", "avatar.html", "avatar.css", "avatar.js", "VISION.md", "favicon.ico", "_headers"].join(", ")}`,
);
