import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 8012;

const ctx = await esbuild.context({
  entryPoints: ["web/main.ts"],
  outfile: "web/app.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  logLevel: "info",
});

if (serve) {
  const { hosts, port: actualPort } = await ctx.serve({ servedir: "web", port });
  console.log(`serving at http://${hosts[0]}:${actualPort}/index.html`);
}
if (watch) {
  await ctx.watch();
  console.log("watching for changes…");
}
if (!watch && !serve) {
  await ctx.rebuild();
  await ctx.dispose();
}
