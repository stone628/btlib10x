import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

// Rolls the library's declarations into one file beside the browser bundle,
// so `import … from "./btlib10x.js"` type-checks with only these two files.
const bundle = await rollup({
  input: "src/index.ts",
  plugins: [dts({ tsconfig: "tsconfig.build.json" })],
});
await bundle.write({ file: "web/btlib10x.d.ts", format: "es" });
await bundle.close();
console.log("web/btlib10x.d.ts");
