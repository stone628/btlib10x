import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { buildStamp } from "./build-stamp.mjs";

const html = readFileSync("web/index.html", "utf8");
const css = readFileSync("web/bt10x.css", "utf8");

const { outputFiles } = await esbuild.build({
  entryPoints: ["web/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  alias: { btlib10x: "./src/index.ts" },
  define: { __BTLIB_VERSION__: JSON.stringify(buildStamp()) },
  loader: { ".txt": "text" },
  write: false,
  logLevel: "info",
});
const app = outputFiles[0].text;

const single = html
  .replace('<link rel="stylesheet" href="bt10x.css" />', `<style>\n${css}\n    </style>`)
  .replace(/<script type="importmap">.*?<\/script>\s*/, "")
  .replace(
    '<script type="module" src="./bt10x.js"></script>',
    `<script type="module">${app}</script>`,
  );

const dest = "dist/standalone/bt10x.html";
rmSync("dist/standalone", { recursive: true, force: true });
mkdirSync("dist/standalone", { recursive: true });
// Embed the catalog in the single file so it launches anywhere (including
// file://, where fetch() is blocked). A payload </script> sequence would
// close the carrier tag early; JSON string escape \/ decodes to /, so this
// keeps every line valid JSONL. The function replacer avoids `$` patterns in
// the payload being interpreted as replacement patterns.
const catalog = readFileSync("data/btlib10x.jsonl", "utf8");
const safeCatalog = catalog.replace(/<\/script/gi, "<\\/script");
const withCatalog = single.replace(
  "</head>",
  () => `<script type="text/plain" id="bt10x-catalog">${safeCatalog}</script>\n</head>`,
);
writeFileSync(dest, withCatalog);
console.log(`${dest}: ${withCatalog.length} bytes (self-contained)`);
