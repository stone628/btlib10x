import { copyFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { buildStamp } from "./build-stamp.mjs";

const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 8012;

const stamp = buildStamp();

// The unified catalog ships as a static file beside the bundles; the app
// fetches it once at boot (see web/terminal/terminal.ts).
copyFileSync("data/btlib10x.jsonl", "web/btlib10x.jsonl");
// VISION.md ships as a hidden static file for reviewing LLM agents only:
// fetched via GET ./VISION.md, never linked in the UI. Source of truth is
// docs/VISION.md.
copyFileSync("docs/VISION.md", "web/VISION.md");

const coreCtx = await esbuild.context({
  entryPoints: ["src/index.ts"],
  outfile: "web/btlib10x.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  define: { __BTLIB_VERSION__: JSON.stringify(stamp) },
  logLevel: "info",
});

const appCtx = await esbuild.context({
  entryPoints: ["web/terminal/terminal.ts"],
  outfile: "web/terminal.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["btlib10x"],
  loader: { ".txt": "text" },
  logLevel: "info",
});

const avatarCtx = await esbuild.context({
  entryPoints: ["web/avatar/avatar.ts"],
  outfile: "web/avatar.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  logLevel: "info",
});

if (serve) {
  const { hosts, port: actualPort } = await appCtx.serve({ servedir: "web", port });
  console.log(
    `serving at http://${hosts[0]}:${actualPort}/index.html (terminal: /terminal.html, avatar: /avatar.html)`,
  );
}
if (watch) {
  await coreCtx.watch();
  await appCtx.watch();
  await avatarCtx.watch();
  console.log("watching for changes…");
}
if (!watch && !serve) {
  await coreCtx.rebuild();
  await appCtx.rebuild();
  await avatarCtx.rebuild();
  await coreCtx.dispose();
  await appCtx.dispose();
  await avatarCtx.dispose();
}
