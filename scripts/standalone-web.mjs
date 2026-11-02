import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { componentStamps } from "./build-stamp.mjs";
import { stripHomeLink } from "./standalone-strip.mjs";

const html = readFileSync("web/terminal.html", "utf8");
// The standalone file must work from file://, so fonts go in as data: URIs.
const css = ["web/bt10x.css", "web/terminal.css"]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")
  .replace(
    /url\("(fonts\/[^"]+\.woff2)"\)/g,
    (_, f) => `url("data:font/woff2;base64,${readFileSync(`web/${f}`).toString("base64")}")`,
  );

const stamps = componentStamps();
const { outputFiles } = await esbuild.build({
  entryPoints: ["web/terminal/terminal.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  alias: { btlib10x: "./src/index.ts" },
  define: {
    __BTLIB_VERSION__: JSON.stringify(stamps.engine),
    __APP_VERSION__: JSON.stringify(stamps.terminal),
    __ENGINE_BUILT_WITH__: JSON.stringify(stamps.engine),
  },
  loader: { ".txt": "text" },
  write: false,
  logLevel: "info",
});
const app = outputFiles[0].text;

const single = stripHomeLink(html)
  .replace(/\s*<link rel="preload"[^>]*>/g, "")
  .replace(
    /<link rel="stylesheet" href="bt10x\.css" \/>\s*<link rel="stylesheet" href="terminal\.css" \/>/,
    () => `<style>\n${css}\n    </style>`,
  )
  .replace(/<script type="importmap">.*?<\/script>\s*/, "")
  .replace(
    '<script type="module" src="./terminal.js"></script>',
    `<script type="module">${app}</script>`,
  );

const dest = "dist/standalone/bt10x.html";
rmSync("dist/standalone", { recursive: true, force: true });
mkdirSync("dist/standalone", { recursive: true });
// Embed the catalog packs in the single file so it launches anywhere (including
// file://, where fetch() is blocked). A payload </script> sequence would
// close the carrier tag early; JSON string escape \/ decodes to /, so this
// keeps every line valid JSONL. The function replacer avoids `$` patterns in
// the payload being interpreted as replacement patterns.
const catalog = readFileSync("data/btlib10x.jsonl", "utf8");
const safeCatalog = catalog.replace(/<\/script/gi, "<\\/script");
const swCatalog = readFileSync("docs/mtf/sw/sw.jsonl", "utf8");
const safeSwCatalog = swCatalog.replace(/<\/script/gi, "<\\/script");
const withCatalog = single.replace(
  "</head>",
  () =>
    `<script type="text/plain" id="bt10x-catalog">${safeCatalog}</script>\n<script type="text/plain" id="bt10x-catalog-sw">${safeSwCatalog}</script>\n</head>`,
);
if (withCatalog.includes('id="home-link"')) throw new Error("standalone: home link in the output");
writeFileSync(dest, withCatalog);
console.log(`${dest}: ${withCatalog.length} bytes (self-contained)`);
