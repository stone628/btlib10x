import { build } from "esbuild";

await build({
  entryPoints: ["web/main.ts"],
  outfile: "web/app.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  logLevel: "info",
});
