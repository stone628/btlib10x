import { copyFileSync, existsSync } from "node:fs";
import * as esbuild from "esbuild";
import { buildStamp } from "./build-stamp.mjs";

const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 8012;

const stamp = buildStamp();

// The catalog packs ship as static files beside the bundles; the app
// fetches them once at boot (see web/terminal/terminal.ts). The base pack
// comes from `npm run pack`, the SW season pack from `npm run pack:sw`.
copyFileSync("data/btlib10x.jsonl", "web/btlib10x.jsonl");
copyFileSync("docs/mtf/sw/sw.jsonl", "web/btlib10x.sw.jsonl");
// Instant-Action-only maps (`npm run pack:ia`); the app runs without them.
if (existsSync("web/instant/instant.jsonl")) {
  copyFileSync("web/instant/instant.jsonl", "web/btlib10x.ia.jsonl");
}
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

// Instant Action (docs/INSTANT.md): engine kept external like the terminal.
const instantCtx = await esbuild.context({
  entryPoints: ["web/instant/instant.ts"],
  outfile: "web/instant.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["btlib10x"],
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

// Avatar gallery pages (docs/GALLERY.md); their API is functions/api/ag/.
const galleryCtx = await esbuild.context({
  entryPoints: { gallery: "web/avatar/gallery.ts", "gallery-admin": "web/avatar/gallery.admin.ts" },
  outdir: "web",
  bundle: true,
  format: "esm",
  target: "es2022",
  logLevel: "info",
});

if (serve) {
  const { hosts, port: actualPort } = await appCtx.serve({ servedir: "web", port });
  console.log(
    `serving at http://${hosts[0]}:${actualPort}/index.html (terminal: /terminal.html, instant: /instant.html, avatar: /avatar.html, gallery: /gallery.html, tui: /tui-demo.html)`,
  );
}
if (watch) {
  await coreCtx.watch();
  await appCtx.watch();
  await instantCtx.watch();
  await avatarCtx.watch();
  await galleryCtx.watch();
  console.log("watching for changes…");
}
if (!watch && !serve) {
  await coreCtx.rebuild();
  await appCtx.rebuild();
  await instantCtx.rebuild();
  await avatarCtx.rebuild();
  await galleryCtx.rebuild();
  await coreCtx.dispose();
  await appCtx.dispose();
  await instantCtx.dispose();
  await avatarCtx.dispose();
  await galleryCtx.dispose();
}
