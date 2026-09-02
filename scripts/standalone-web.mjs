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
  write: false,
  logLevel: "info",
});
const app = outputFiles[0].text;

const single = html
  .replace('<link rel="stylesheet" href="bt10x.css" />', `<style>\n${css}\n    </style>`)
  .replace(/<script type="importmap">.*?<\/script>\s*/, "")
  .replace(
    '<script type="module" src="./app.js"></script>',
    `<script type="module">${app}</script>`,
  );

const dest = "dist/standalone/bt10x.html";
rmSync("dist/standalone", { recursive: true, force: true });
mkdirSync("dist/standalone", { recursive: true });
writeFileSync(dest, single);
console.log(`${dest}: ${single.length} bytes`);
