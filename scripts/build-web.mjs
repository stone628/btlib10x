import * as esbuild from "esbuild";
import { buildStamp } from "./build-stamp.mjs";

const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 8012;

const stamp = buildStamp();

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
  entryPoints: ["web/main.ts"],
  outfile: "web/app.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["btlib10x"],
  logLevel: "info",
});

if (serve) {
  const { hosts, port: actualPort } = await appCtx.serve({ servedir: "web", port });
  console.log(`serving at http://${hosts[0]}:${actualPort}/index.html`);
}
if (watch) {
  await coreCtx.watch();
  await appCtx.watch();
  console.log("watching for changes…");
}
if (!watch && !serve) {
  await coreCtx.rebuild();
  await appCtx.rebuild();
  await coreCtx.dispose();
  await appCtx.dispose();
}
